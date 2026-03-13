require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const { Streamer, prepareStream, playStream, Utils, Encoders } = require('@dank074/discord-video-stream');
const { execSync, exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');

// Đường dẫn đến ffmpeg và yt-dlp trong thư mục bin/
process.env.FFMPEG_PATH = path.join(__dirname, 'bin', 'ffmpeg.exe');
const YTDLP_PATH = path.join(__dirname, 'bin', 'yt-dlp.exe');

const client = new Client();
const streamer = new Streamer(client);

// Trạng thái bot
let isStreaming = false;
let currentTimestamp = 0;
let currentVideoUrl = "";
let activeCommand = null;
let activeMergeProcess = null;

const CHUNK_THRESHOLD = 1200; 
const PREFIX = "!.";
const ADMIN_IDS = (process.env.ADMIN_ID || "").split(",").map(id => id.trim()).filter(Boolean);

// Detect GPU lúc khởi động
let HAS_GPU = false;
try {
    execSync('nvidia-smi', { stdio: 'ignore' });
    HAS_GPU = true;
} catch (e) {
    HAS_GPU = false;
}

/**
 * Lấy cấu hình chất lượng dựa trên Nitro, giới hạn bởi chất lượng gốc của video
 */
function getNitroQuality(client, videoInfo) {
    const premiumType = client.user.premiumType;
    const gpu = HAS_GPU;
    let maxH, maxBitrate, maxAudioBitrate;
    if (premiumType === 2) { maxH = 1080; maxBitrate = 8000; maxAudioBitrate = 128; }
    else if (premiumType === 1) { maxH = 1080; maxBitrate = 5000; maxAudioBitrate = 128; }
    else { maxH = 720; maxBitrate = 2500; maxAudioBitrate = 96; }

    // Không upscale vượt quá chất lượng gốc
    const srcH = videoInfo.height || 720;
    const srcFps = videoInfo.fps || 30;
    const height = Math.min(maxH, srcH);
    const fps = gpu ? Math.min(60, srcFps) : Math.min(30, srcFps);

    return { height, fps, bitrate: maxBitrate, audioBitrate: maxAudioBitrate };
}

/**
 * Lấy thông tin video: duration, height, fps — ưu tiên DASH để biết chất lượng thực
 */
async function getVideoInfo(url) {
    try {
        const command = `"${YTDLP_PATH}" --print "%(duration)s|%(height)s|%(fps)s" -f "bv*[ext=mp4]/bv*/b" -S "res,fps" --quiet --no-warnings "${url}"`;
        const { stdout } = await execAsync(command);
        const [dur, h, f] = stdout.trim().split('|');
        return {
            duration: parseInt(dur) || 0,
            height: parseInt(h) || 0,
            fps: parseInt(f) || 0
        };
    } catch (e) {
        return { duration: 0, height: 0, fps: 0 };
    }
}

/**
 * Lấy link stream YouTube (async) — ưu tiên DASH (video+audio riêng) cho chất lượng cao
 * Trả về { videoUrl, audioUrl } — audioUrl = null nếu là stream gộp
 */
async function getYouTubeStream(url, maxHeight) {
    try {
        const fmt = `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]/bv*[height<=${maxHeight}]+ba/b[ext=mp4]/b`;
        const { stdout } = await execAsync(`"${YTDLP_PATH}" -f "${fmt}" -S "res:${maxHeight},fps" --get-url "${url}"`);
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        if (lines.length >= 2) {
            return { videoUrl: lines[0].trim(), audioUrl: lines[1].trim() };
        }
        return { videoUrl: lines[0]?.trim() || null, audioUrl: null };
    } catch (e) {
        return { videoUrl: null, audioUrl: null };
    }
}

/**
 * Hàm phát video chính
 */
async function startChunkedVideo(guildId, voiceChannelId, videoSource, message) {
    isStreaming = true;
    currentTimestamp = 0;
    currentVideoUrl = videoSource;

    // Lấy info video (async - không chặn event loop)
    const videoInfo = await getVideoInfo(videoSource);
    const totalDuration = videoInfo.duration;
    const dynamicChunkDuration = 1800;

    const quality = getNitroQuality(client, videoInfo);
    message.channel.send(
        `📺 **Đang phát:** ${quality.height}p${quality.fps} | ` +
        `${totalDuration > 0 ? `${Math.floor(totalDuration / 60)}ph${totalDuration % 60}s` : 'Live'}`
    );

    try {
        await streamer.joinVoice(guildId, voiceChannelId);

        // Lấy URL chunk đầu tiên
        let nextStreamData = await getYouTubeStream(currentVideoUrl, quality.height);

        while (isStreaming) {
            if (totalDuration > 0 && currentTimestamp >= totalDuration) break;

            const streamData = nextStreamData;
            if (!streamData.videoUrl) break;
            nextStreamData = { videoUrl: null, audioUrl: null };

            const encoder = HAS_GPU
                ? Encoders.nvenc({ preset: "p4" })
                : Encoders.software({ x264: { preset: "ultrafast" } });
            const remainingTime = totalDuration > 0 ? (totalDuration - currentTimestamp) : dynamicChunkDuration;
            const currentRunDuration = Math.min(dynamicChunkDuration, remainingTime);
            
            const seekTime = currentTimestamp > 2 ? currentTimestamp - 2 : currentTimestamp;
            const totalTime = (currentRunDuration + (currentTimestamp > 2 ? 2 : 0)).toString();

            let source;
            if (streamData.audioUrl) {
                // DASH: merge video+audio bằng ffmpeg copy (không tốn CPU)
                const ffmpegPath = process.env.FFMPEG_PATH;
                activeMergeProcess = spawn(ffmpegPath, [
                    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
                    '-ss', seekTime.toString(), '-i', streamData.videoUrl,
                    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
                    '-ss', seekTime.toString(), '-i', streamData.audioUrl,
                    '-t', totalTime,
                    '-c', 'copy', '-f', 'matroska',
                    '-map', '0:v', '-map', '1:a',
                    'pipe:1'
                ], { stdio: ['ignore', 'pipe', 'ignore'] });
                source = activeMergeProcess.stdout;
            } else {
                // Stream gộp: dùng URL trực tiếp
                source = streamData.videoUrl;
            }

            const streamOpts = {
                encoder,
                height: quality.height,
                frameRate: quality.fps,
                bitrateVideo: quality.bitrate,
                bitrateAudio: quality.audioBitrate,
                includeAudio: true,
                minimizeLatency: true,
                readrateInitialBurst: 10,
                videoCodec: Utils.normalizeVideoCodec("H264"),
            };

            // Chỉ thêm seek/duration khi dùng URL trực tiếp (không phải pipe)
            if (!streamData.audioUrl) {
                streamOpts.customInputOptions = [
                    '-ss', seekTime.toString(),
                    '-t', totalTime,
                ];
            }

            const { command, output } = prepareStream(source, streamOpts);

            activeCommand = command;

            command.on("error", (err) => {
                if (!err.message.includes("Output stream closed") && !err.message.includes("SIGKILL")) {
                    console.error('[FFmpeg Error]', err.message);
                }
            });

            // Prefetch URL cho chunk tiếp theo trong lúc đang phát
            const needsNextChunk = totalDuration === 0 || (currentTimestamp + currentRunDuration < totalDuration);
            const prefetchPromise = (needsNextChunk && isStreaming)
                ? getYouTubeStream(currentVideoUrl, quality.height)
                : Promise.resolve({ videoUrl: null, audioUrl: null });

            await playStream(output, streamer, { type: "go-live" });

            // Dọn merge process
            if (activeMergeProcess) {
                try { activeMergeProcess.kill(); } catch (e) {}
                activeMergeProcess = null;
            }

            if (!isStreaming) break;

            currentTimestamp += currentRunDuration;

            if (totalDuration > 0 && totalDuration <= CHUNK_THRESHOLD) break;

            // Lấy kết quả prefetch (thường đã xong từ lúc đang phát)
            if (isStreaming && (totalDuration === 0 || currentTimestamp < totalDuration)) {
                nextStreamData = await prefetchPromise;
            }
        }

        if (isStreaming) {
            message.channel.send("✅ Đã phát xong video.");
            stopStreaming();
        }
    } catch (error) {
        console.error('[System Error]', error);
        stopStreaming();
    }
}

function stopStreaming() {
    isStreaming = false;
    currentTimestamp = 0;
    currentVideoUrl = "";
    if (activeCommand) {
        try { activeCommand.kill(); } catch (e) {}
        activeCommand = null;
    }
    if (activeMergeProcess) {
        try { activeMergeProcess.kill(); } catch (e) {}
        activeMergeProcess = null;
    }
    try { streamer.leaveVoice(); } catch (e) {}
}

client.on('ready', () => {
    console.log(`-----------------------------------------`);
    console.log(`YouTube Live Player Ready!`);
    console.log(`User: ${client.user.tag}`);
    console.log(`GPU: ${HAS_GPU ? 'NVENC (60fps)' : 'CPU only (30fps)'}`);
    console.log(`Commands: !play, !stop, !help`);
    console.log(`-----------------------------------------`);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (ADMIN_IDS.length > 0 && !ADMIN_IDS.includes(message.author.id)) return;

    const args = message.content.split(" ");
    const command = args[0].toLowerCase();

    if (command === `${PREFIX}help`) {
        message.reply(`**DANH SÁCH LỆNH:**\n` +
                      `1️⃣ \`!play <link_youtube>\`: Phát video từ YouTube.\n` +
                      `2️⃣ \`!stop\`: Dừng phát và rời khỏi kênh thoại.\n` +
                      `*Lưu ý: Chỉ hỗ trợ link YouTube.*`);
    }

    if (command === `${PREFIX}play`) {
        const videoUrl = args[1];
        const guildId = message.guildId;

        if (!videoUrl) return message.reply("❓ Vui lòng gửi kèm link YouTube (Ví dụ: `!play https://youtube.com/...`) hoặc dùng !help.");

        if (!guildId) {
            return message.reply("❌ Lệnh này chỉ dùng trong server.");
        }

        // Fetch member để lấy voice state mới nhất
        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        const voiceId = member?.voice?.channelId;

        if (!voiceId) {
            return message.reply("🎙️ Hãy vào một voice channel trước khi dùng !play.");
        }

        if (!videoUrl.includes("youtube.com") && !videoUrl.includes("youtu.be")) {
            return message.reply("❌ Chỉ hỗ trợ link YouTube.");
        }

        if (isStreaming) stopStreaming();
        
        message.reply(`⏳ Đang xử lý video... (${HAS_GPU ? 'NVENC GPU' : 'x264 CPU'})`);
        startChunkedVideo(guildId, voiceId, videoUrl, message);
    }

    if (command === `${PREFIX}stop`) {
        stopStreaming();
        message.reply("⏹️ Đã dừng phát video và rời kênh.");
    }
});

if (!process.env.DISCORD_TOKEN || ADMIN_IDS.length === 0) {
    console.error("Thiếu DISCORD_TOKEN hoặc ADMIN_ID trong .env");
    process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
