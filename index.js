if (!globalThis.WebSocket) {
    globalThis.WebSocket = require('ws');
}

require('dotenv').config();
const { Client } = require('discord.js-selfbot-v13');
const { Streamer, prepareStream, playStream, Utils, Encoders } = require('@dank074/discord-video-stream');
const { execSync, execFile, spawn } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { PassThrough } = require('stream');
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

let HAS_NODE = false;
try {
    const nodeVer = execSync('node --version', { timeout: 5000 }).toString().trim();
    HAS_NODE = true;
    console.log(`[Init] Node runtime detected for yt-dlp JS: ${nodeVer}`);
} catch (e) {
    console.warn('[Init] Node runtime not detected for yt-dlp JS runtime fallback.');
}

let HAS_DENO = false;
try {
    const denoVer = execSync('deno --version', { timeout: 5000 }).toString().split('\n')[0].trim();
    HAS_DENO = true;
    console.log(`[Init] Optional Deno runtime detected for yt-dlp JS: ${denoVer}`);
} catch (e) {
    console.log('[Init] Deno not found. Continuing with Node/default yt-dlp JS runtime.');
}

let YTDLP_JS_RUNTIME_ARGS = [];
if (HAS_NODE) {
    // Clear yt-dlp default runtimes, then force Node to avoid Deno dependency.
    YTDLP_JS_RUNTIME_ARGS = ['--no-js-runtimes', '--js-runtimes', 'node'];
    console.log('[Init] yt-dlp JS runtime forced to: node');
} else if (HAS_DENO) {
    // Node is unavailable; use Deno as optional fallback.
    YTDLP_JS_RUNTIME_ARGS = ['--no-js-runtimes', '--js-runtimes', 'deno'];
    console.log('[Init] yt-dlp JS runtime fallback: deno');
} else {
    console.warn('[Init] No external JS runtime found for yt-dlp; using yt-dlp defaults only.');
}

function withYtdlpRuntimeArgs(args = []) {
    return [...YTDLP_JS_RUNTIME_ARGS, ...args];
}

const client = new Client();
const streamer = new Streamer(client);

let isStreaming = false;
let currentTimestamp = 0;
let currentVideoUrl = "";
let activeCommand = null;
let activeMergeProcess = null;

const CHUNK_THRESHOLD = 1200;
const BUFFER_SIZE = 64 * 1024 * 1024; // 64MB RAM buffer for smooth CPU usage
const PREFIX = "!";
const ADMIN_IDS = (process.env.ADMIN_ID || "").split(",").map(id => id.trim()).filter(Boolean);
const YOUTUBE_REFERER = 'https://www.youtube.com/';
const YOUTUBE_ORIGIN = 'https://www.youtube.com';

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
    const infoArgs = ['--print', '%(duration)s|%(height)s|%(fps)s|%(is_live)s', '-S', 'res,fps', '--quiet', '--no-warnings'];
    const parseInfo = (stdout) => {
        const [dur, h, f, live] = stdout.trim().split('|');
        return {
            duration: parseInt(dur) || 0,
            height: parseInt(h) || 0,
            fps: Math.round(parseFloat(f)) || 0,
            isLive: live === 'True' || dur === 'NA',
        };
    };
    try {
        const { stdout } = await execFileAsync(YTDLP_PATH, withYtdlpRuntimeArgs([...infoArgs, url]));
        return parseInfo(stdout);
    } catch (e) {
        console.error('[yt-dlp getVideoInfo] Attempt 1 failed:', e.stderr || e.message);
        if (HAS_COOKIE) {
            console.log('[yt-dlp getVideoInfo] Retrying with cookie...');
            try {
                const { stdout } = await execFileAsync(YTDLP_PATH, withYtdlpRuntimeArgs([...infoArgs, '--cookies', COOKIE_PATH, url]));
                return parseInfo(stdout);
            } catch (e2) {
                console.error('[yt-dlp getVideoInfo] Attempt 2 (cookie) failed:', e2.stderr || e2.message);
            }
        }
        return { duration: 0, height: 0, fps: 0, isLive: false };
    }
}

function normalizeStreamHeaders(headers = {}) {
    return {
        Referer: YOUTUBE_REFERER,
        Origin: YOUTUBE_ORIGIN,
        Connection: 'keep-alive',
        ...headers,
    };
}

function createEmptyStreamData(usePipe = false) {
    return {
        videoUrl: null,
        audioUrl: null,
        videoHeaders: null,
        audioHeaders: null,
        usePipe,
    };
}

function parseStreamInfo(stdout) {
    const info = JSON.parse(stdout);
    const requestedFormats = Array.isArray(info.requested_formats) ? info.requested_formats : [];
    const videoFormat = requestedFormats.find(format => format.vcodec && format.vcodec !== 'none') || requestedFormats[0] || null;
    const audioFormat = requestedFormats.find(format => format.acodec && format.acodec !== 'none' && format.vcodec === 'none') || null;

    if (videoFormat) {
        return {
            videoUrl: videoFormat.url || null,
            audioUrl: audioFormat?.url || null,
            videoHeaders: normalizeStreamHeaders(videoFormat.http_headers || info.http_headers || {}),
            audioHeaders: audioFormat ? normalizeStreamHeaders(audioFormat.http_headers || info.http_headers || {}) : null,
            usePipe: false,
        };
    }

    return {
        videoUrl: info.url || null,
        audioUrl: null,
        videoHeaders: normalizeStreamHeaders(info.http_headers || {}),
        audioHeaders: null,
        usePipe: false,
    };
}

function formatHeadersForFfmpeg(headers = {}) {
    return Object.entries(headers)
        .filter(([, value]) => value !== undefined && value !== null && value !== '')
        .map(([key, value]) => `${key}: ${value}`)
        .join('\r\n');
}

function buildYtdlpFormat(maxHeight) {
    // Direct mode: exclude HLS (ffmpeg opens URLs directly, HLS segments would need yt-dlp auth)
    return [
        `bv*[protocol!=m3u8_native][protocol!=m3u8][height<=${maxHeight}][ext=mp4]+ba[protocol!=m3u8_native][protocol!=m3u8][ext=m4a]`,
        `bv*[protocol!=m3u8_native][protocol!=m3u8][height<=${maxHeight}]+ba[protocol!=m3u8_native][protocol!=m3u8]`,
        `b[protocol!=m3u8_native][protocol!=m3u8][height<=${maxHeight}][ext=mp4]`,
        `b[protocol!=m3u8_native][protocol!=m3u8][height<=${maxHeight}]`,
    ].join('/');
}

function buildYtdlpPipeFormat(maxHeight) {
    // Pipe mode: allow ALL protocols including HLS — yt-dlp handles auth/segments itself
    // This allows 720p/1080p HLS when direct HTTPS streams are unavailable (flagged IP)
    return [
        `bv*[height<=${maxHeight}][ext=mp4]+ba[ext=m4a]`,
        `bv*[height<=${maxHeight}]+ba`,
        `b[height<=${maxHeight}][ext=mp4]`,
        `b[height<=${maxHeight}]`,
    ].join('/');
}

async function getYouTubeStream(url, maxHeight) {
    const fmt = buildYtdlpFormat(maxHeight);
    const baseArgs = ['-f', fmt, '-S', `res:${maxHeight},fps`, '--dump-single-json', '--no-playlist', '--no-warnings'];

    try {
        const { stdout } = await execFileAsync(YTDLP_PATH, withYtdlpRuntimeArgs([...baseArgs, url]));
        return parseStreamInfo(stdout);
    } catch (e) {
        console.error('[yt-dlp getYouTubeStream] Attempt 1 failed:', e.stderr || e.message);
        if (HAS_COOKIE) {
            console.log('[yt-dlp getYouTubeStream] Retrying with cookie...');
            try {
                await execFileAsync(YTDLP_PATH, withYtdlpRuntimeArgs([...baseArgs, '--cookies', COOKIE_PATH, url]));
                console.log('[yt-dlp getYouTubeStream] Cookie retry succeeded, switching to stable cookie pipe mode');
                return createEmptyStreamData(true);
            } catch (e2) {
                console.error('[yt-dlp getYouTubeStream] Attempt 2 (cookie) failed:', e2.stderr || e2.message);
            }

            console.log('[yt-dlp] Switching to pipe mode with cookie as final fallback');
            return createEmptyStreamData(true);
        }
        return createEmptyStreamData(false);
    }
}

function spawnYtdlpPipe(url, maxHeight, isLive = false) {
    const fmt = buildYtdlpPipeFormat(maxHeight);
    const extraArgs = isLive ? [] : ['--extractor-args', 'youtube:player_client=tv_embedded'];
    const args = withYtdlpRuntimeArgs([
        '-f', fmt,
        '-S', `res:${maxHeight},fps`,
        '--cookies', COOKIE_PATH,
        ...extraArgs,
        '--merge-output-format', 'mkv',
        '--ffmpeg-location', process.env.FFMPEG_PATH,
        '-o', '-',
        url
    ]);
    console.log(`[yt-dlp pipe] Spawning yt-dlp pipe mode... client=${isLive ? 'default (live)' : 'tv_embedded'}`);
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
    const isLive = videoInfo.isLive;
    const dynamicChunkDuration = 1800;

    const quality = getNitroQuality(client, videoInfo);
    message.channel.send(
        `📺 **Now playing:** ${quality.height}p${quality.fps} | ` +
        `${isLive ? 'Live' : `${Math.floor(totalDuration / 60)}m${totalDuration % 60}s`}`
    );

    try {
        await streamer.joinVoice(guildId, voiceChannelId);

        let nextStreamData = await getYouTubeStream(currentVideoUrl, quality.height);

        if (nextStreamData.usePipe) {
            console.log('[Stream] Pipe mode: yt-dlp will pipe video directly');
            message.channel.send('📡 Playing via pipe mode (cookie)...');

            activeMergeProcess = spawnYtdlpPipe(currentVideoUrl, quality.height, isLive);
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
                minimizeLatency: false,
                readrateInitialBurst: 30,
                videoCodec: Utils.normalizeVideoCodec("H264"),
            };

            const { command, output } = prepareStream(source, streamOpts);
            activeCommand = command;

            command.on("error", (err) => {
                if (!err.message.includes("Output stream closed") && !err.message.includes("SIGKILL")) {
                    console.error('[FFmpeg Error]', err.message);
                }
            });

            const buffered = new PassThrough({ highWaterMark: BUFFER_SIZE });
            output.pipe(buffered);
            output.on('error', () => buffered.destroy());

            await playStream(buffered, streamer, { type: "go-live" });

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
            nextStreamData = createEmptyStreamData(false);

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
                const videoHeaders = formatHeadersForFfmpeg(streamData.videoHeaders);
                const audioHeaders = formatHeadersForFfmpeg(streamData.audioHeaders || streamData.videoHeaders);
                activeMergeProcess = spawn(ffmpegPath, [
                    '-headers', videoHeaders,
                    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
                    '-ss', seekTime.toString(), '-i', streamData.videoUrl,
                    '-headers', audioHeaders,
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
                minimizeLatency: false,
                readrateInitialBurst: 30,
                videoCodec: Utils.normalizeVideoCodec("H264"),
                customHeaders: streamData.videoHeaders || undefined,
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

            const buffered = new PassThrough({ highWaterMark: BUFFER_SIZE });
            output.pipe(buffered);
            output.on('error', () => buffered.destroy());

            const needsNextChunk = totalDuration === 0 || (currentTimestamp + currentRunDuration < totalDuration);
            const prefetchPromise = (needsNextChunk && isStreaming)
                ? getYouTubeStream(currentVideoUrl, quality.height)
                : Promise.resolve(createEmptyStreamData(false));

            await playStream(buffered, streamer, { type: "go-live" });

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
        message.channel.send('❌ An error occurred during playback.').catch(() => {});
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

        let parsedUrl;
        try {
            parsedUrl = new URL(videoUrl);
        } catch {
            return message.reply("❌ Invalid URL.");
        }
        const validHosts = ['www.youtube.com', 'youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'];
        if (!validHosts.includes(parsedUrl.hostname)) {
            return message.reply("❌ Only YouTube links are supported.");
        }

        if (isStreaming) stopStreaming();
        isStreaming = true;

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
