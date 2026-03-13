if (!globalThis.WebSocket) {
    globalThis.WebSocket = require('ws');
}

require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const { Streamer, prepareStream, playStream, Utils, Encoders } = require('@dank074/discord-video-stream');
const { execSync, exec, spawn } = require('child_process');
const { promisify } = require('util');
const execAsync = promisify(exec);
const path = require('path');
const fs = require('fs');

const isWindows = process.platform === 'win32';
process.env.FFMPEG_PATH = path.join(__dirname, 'bin', isWindows ? 'ffmpeg.exe' : 'ffmpeg');
const YTDLP_PATH = path.join(__dirname, 'bin', isWindows ? 'yt-dlp.exe' : 'yt-dlp');

if (!isWindows) {
    try {
        fs.chmodSync(process.env.FFMPEG_PATH, 0o755);
        fs.chmodSync(YTDLP_PATH, 0o755);
        console.log('[Init] Granted execute permission for ffmpeg and yt-dlp');
    } catch (e) {
        console.error('[Init] Cannot grant execute permission for binaries:', e.message);
    }
}

try {
    const ver = execSync(`"${YTDLP_PATH}" --version`, { timeout: 10000 }).toString().trim();
    console.log(`[Init] yt-dlp version: ${ver}`);
} catch (e) {
    console.error(`[Init] yt-dlp is not working! Error: ${e.message}`);
    console.error('[Init] Make sure bin/yt-dlp is the correct binary for the current OS (' + process.platform + ')');
}

let HAS_DENO = false;
if (!isWindows) {
    try {
        const denoVer = execSync('deno --version', { timeout: 5000 }).toString().split('\n')[0].trim();
        HAS_DENO = true;
        console.log(`[Init] ${denoVer}`);
    } catch (e) {
        console.warn('[Init] deno is not installed! yt-dlp needs deno to decode YouTube signatures.');
        console.warn('[Init] Install with: curl -fsSL https://deno.land/install.sh | sh');
    }
}

const client = new Client();
const streamer = new Streamer(client);

let isStreaming = false;
let currentTimestamp = 0;
let currentVideoUrl = "";
let activeCommand = null;
let activeMergeProcess = null;

const CHUNK_THRESHOLD = 1200;
const PREFIX = "!";
const ADMIN_IDS = (process.env.ADMIN_ID || "").split(",").map(id => id.trim()).filter(Boolean);

const COOKIE_PATH = path.join(__dirname, 'cookies.txt');
const HAS_COOKIE = fs.existsSync(COOKIE_PATH);
if (HAS_COOKIE) {
    console.log('[Init] Found cookies.txt');
    if (!isWindows) {
        try {
            const raw = fs.readFileSync(COOKIE_PATH, 'utf8');
            if (raw.includes('\r\n')) {
                fs.writeFileSync(COOKIE_PATH, raw.replace(/\r\n/g, '\n'), 'utf8');
                console.log('[Init] Fixed line endings in cookies.txt (\\r\\n -> \\n) for Linux');
            }
        } catch (e) {
            console.error('[Init] Cannot fix line endings in cookies.txt:', e.message);
        }
    }
}
const COOKIE_FLAG = HAS_COOKIE ? `--cookies "${COOKIE_PATH}"` : '';

let HAS_GPU = false;
try {
    execSync('nvidia-smi', { stdio: 'ignore' });
    HAS_GPU = true;
} catch (e) {
    HAS_GPU = false;
}

function getNitroQuality(client, videoInfo) {
    const premiumType = client.user.premiumType;
    const gpu = HAS_GPU;
    let maxH, maxBitrate, maxAudioBitrate;
    if (premiumType === 2) { maxH = 1080; maxBitrate = 8000; maxAudioBitrate = 128; }
    else if (premiumType === 1) { maxH = 1080; maxBitrate = 5000; maxAudioBitrate = 128; }
    else { maxH = 720; maxBitrate = 2500; maxAudioBitrate = 96; }

    const srcH = videoInfo.height || 720;
    const srcFps = videoInfo.fps || 30;
    const height = Math.min(maxH, srcH);
    const fps = gpu ? Math.min(60, srcFps) : Math.min(30, srcFps);

    return { height, fps, bitrate: maxBitrate, audioBitrate: maxAudioBitrate };
}

async function getVideoInfo(url) {
    const base = `"${YTDLP_PATH}" --print "%(duration)s|%(height)s|%(fps)s" -f "bv*[protocol!=m3u8_native][protocol!=m3u8][ext=mp4]/bv*[protocol!=m3u8_native][protocol!=m3u8]/b[protocol!=m3u8_native][protocol!=m3u8]" -S "res,fps" --quiet --no-warnings`;
    try {
        const { stdout } = await execAsync(`${base} "${url}"`);
        const [dur, h, f] = stdout.trim().split('|');
        return { duration: parseInt(dur) || 0, height: parseInt(h) || 0, fps: parseInt(f) || 0 };
    } catch (e) {
        console.error('[yt-dlp getVideoInfo] Attempt 1 failed:', e.stderr || e.message);
        if (COOKIE_FLAG) {
            console.log('[yt-dlp getVideoInfo] Retrying with cookie...');
            try {
                const { stdout } = await execAsync(`${base} ${COOKIE_FLAG} "${url}"`);
                const [dur, h, f] = stdout.trim().split('|');
                return { duration: parseInt(dur) || 0, height: parseInt(h) || 0, fps: parseInt(f) || 0 };
            } catch (e2) {
                console.error('[yt-dlp getVideoInfo] Attempt 2 (cookie) failed:', e2.stderr || e2.message);
            }
        }
        return { duration: 0, height: 0, fps: 0 };
    }
}

async function getYouTubeStream(url, maxHeight) {
    const fmt = `bv*[protocol!=m3u8_native][protocol!=m3u8][height<=${maxHeight}][ext=mp4]+ba[protocol!=m3u8_native][protocol!=m3u8][ext=m4a]/bv*[protocol!=m3u8_native][protocol!=m3u8][height<=${maxHeight}]+ba[protocol!=m3u8_native][protocol!=m3u8]/b[protocol!=m3u8_native][protocol!=m3u8][ext=mp4]/b[protocol!=m3u8_native][protocol!=m3u8]`;
    const base = `"${YTDLP_PATH}" -f "${fmt}" -S "res:${maxHeight},fps" --get-url`;
    try {
        const { stdout } = await execAsync(`${base} "${url}"`);
        const lines = stdout.trim().split('\n').filter(l => l.trim());
        if (lines.length >= 2) return { videoUrl: lines[0].trim(), audioUrl: lines[1].trim(), usePipe: false };
        return { videoUrl: lines[0]?.trim() || null, audioUrl: null, usePipe: false };
    } catch (e) {
        console.error('[yt-dlp getYouTubeStream] Attempt 1 failed:', e.stderr || e.message);
        if (HAS_COOKIE) {
            console.log('[yt-dlp] Switching to pipe mode with cookie (avoiding 403)');
            return { videoUrl: null, audioUrl: null, usePipe: true };
        }
        return { videoUrl: null, audioUrl: null, usePipe: false };
    }
}

function spawnYtdlpPipe(url, maxHeight) {
    const fmt = `bv*[protocol!=m3u8_native][protocol!=m3u8][height<=${maxHeight}][ext=mp4]+ba[protocol!=m3u8_native][protocol!=m3u8][ext=m4a]/bv*[protocol!=m3u8_native][protocol!=m3u8][height<=${maxHeight}]+ba[protocol!=m3u8_native][protocol!=m3u8]/b[protocol!=m3u8_native][protocol!=m3u8][ext=mp4]/b[protocol!=m3u8_native][protocol!=m3u8]`;
    const args = [
        '-f', fmt,
        '-S', `res:${maxHeight},fps`,
        '--cookies', COOKIE_PATH,
        '--merge-output-format', 'mkv',
        '--ffmpeg-location', process.env.FFMPEG_PATH,
        '-o', '-',
        url
    ];
    console.log('[yt-dlp pipe] Spawning yt-dlp pipe mode...');
    const proc = spawn(YTDLP_PATH, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    proc.stderr.on('data', d => {
        const msg = d.toString().trim();
        if (msg && !msg.startsWith('[download]')) console.log('[yt-dlp pipe]', msg);
    });
    return proc;
}

async function startChunkedVideo(guildId, voiceChannelId, videoSource, message) {
    isStreaming = true;
    currentTimestamp = 0;
    currentVideoUrl = videoSource;

    const videoInfo = await getVideoInfo(videoSource);
    const totalDuration = videoInfo.duration;
    const dynamicChunkDuration = 1800;

    const quality = getNitroQuality(client, videoInfo);
    message.channel.send(
        `📺 **Now playing:** ${quality.height}p${quality.fps} | ` +
        `${totalDuration > 0 ? `${Math.floor(totalDuration / 60)}m${totalDuration % 60}s` : 'Live'}`
    );

    try {
        await streamer.joinVoice(guildId, voiceChannelId);

        let nextStreamData = await getYouTubeStream(currentVideoUrl, quality.height);

        if (nextStreamData.usePipe) {
            console.log('[Stream] Pipe mode: yt-dlp will pipe video directly');
            message.channel.send('📡 Playing via pipe mode (cookie)...');

            activeMergeProcess = spawnYtdlpPipe(currentVideoUrl, quality.height);
            const source = activeMergeProcess.stdout;

            const encoder = HAS_GPU
                ? Encoders.nvenc({ preset: "p4" })
                : Encoders.software({ x264: { preset: "ultrafast" } });

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

            const { command, output } = prepareStream(source, streamOpts);
            activeCommand = command;

            command.on("error", (err) => {
                if (!err.message.includes("Output stream closed") && !err.message.includes("SIGKILL")) {
                    console.error('[FFmpeg Error]', err.message);
                }
            });

            await playStream(output, streamer, { type: "go-live" });

            if (activeMergeProcess) {
                try { activeMergeProcess.kill(); } catch (e) {}
                activeMergeProcess = null;
            }

            if (isStreaming) {
                message.channel.send("✅ Video playback finished.");
                stopStreaming();
            }
            return;
        }

        while (isStreaming) {
            if (totalDuration > 0 && currentTimestamp >= totalDuration) break;

            const streamData = nextStreamData;
            if (!streamData.videoUrl) {
                console.error('[Stream] Could not get stream URL from yt-dlp');
                message.channel.send('❌ Could not get video link. Please check the YouTube link or see the log.');
                break;
            }
            nextStreamData = { videoUrl: null, audioUrl: null, usePipe: false };

            const encoder = HAS_GPU
                ? Encoders.nvenc({ preset: "p4" })
                : Encoders.software({ x264: { preset: "ultrafast" } });
            const remainingTime = totalDuration > 0 ? (totalDuration - currentTimestamp) : dynamicChunkDuration;
            const currentRunDuration = Math.min(dynamicChunkDuration, remainingTime);

            const seekTime = currentTimestamp > 2 ? currentTimestamp - 2 : currentTimestamp;
            const totalTime = (currentRunDuration + (currentTimestamp > 2 ? 2 : 0)).toString();

            let source;
            if (streamData.audioUrl) {
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

            const needsNextChunk = totalDuration === 0 || (currentTimestamp + currentRunDuration < totalDuration);
            const prefetchPromise = (needsNextChunk && isStreaming)
                ? getYouTubeStream(currentVideoUrl, quality.height)
                : Promise.resolve({ videoUrl: null, audioUrl: null, usePipe: false });

            await playStream(output, streamer, { type: "go-live" });

            if (activeMergeProcess) {
                try { activeMergeProcess.kill(); } catch (e) {}
                activeMergeProcess = null;
            }

            if (!isStreaming) break;

            currentTimestamp += currentRunDuration;

            if (totalDuration > 0 && totalDuration <= CHUNK_THRESHOLD) break;

            if (isStreaming && (totalDuration === 0 || currentTimestamp < totalDuration)) {
                nextStreamData = await prefetchPromise;
            }
        }

        if (isStreaming) {
            message.channel.send("✅ Video playback finished.");
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
        message.reply(`**COMMAND LIST:**\n` +
                      `1️⃣ \`!play <youtube_link>\`: Play a video from YouTube.\n` +
                      `2️⃣ \`!stop\`: Stop playback and leave the voice channel.\n` +
                      `*Note: Only YouTube links are supported.*`);
    }

    if (command === `${PREFIX}play`) {
        const videoUrl = args[1];
        const guildId = message.guildId;

        if (!videoUrl) return message.reply("❓ Please provide a YouTube link (Example: `!play https://youtube.com/...`) or use !help.");

        if (!guildId) {
            return message.reply("❌ This command can only be used in a server.");
        }

        const member = await message.guild.members.fetch(message.author.id).catch(() => null);
        const voiceId = member?.voice?.channelId;

        if (!voiceId) {
            return message.reply("🎙️ Please join a voice channel before using !play.");
        }

        if (!videoUrl.includes("youtube.com") && !videoUrl.includes("youtu.be")) {
            return message.reply("❌ Only YouTube links are supported.");
        }

        if (isStreaming) stopStreaming();

        message.reply(`⏳ Processing video... (${HAS_GPU ? 'NVENC GPU' : 'x264 CPU'})`);
        startChunkedVideo(guildId, voiceId, videoUrl, message);
    }

    if (command === `${PREFIX}stop`) {
        stopStreaming();
        message.reply("⏹️ Stopped playback and left the channel.");
    }
});

if (!process.env.DISCORD_TOKEN || ADMIN_IDS.length === 0) {
    console.error("Missing DISCORD_TOKEN or ADMIN_ID in .env");
    process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
