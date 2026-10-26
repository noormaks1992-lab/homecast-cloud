'use strict';

// Normalize Twitch's official embed URL to a canonical public Twitch URL that yt-dlp understands.
// This does not authenticate, defeat access controls, or bypass subscriber-only restrictions.
const TWITCH_HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv', 'player.twitch.tv', 'clips.twitch.tv']);
const CHANNEL_RE = /^[A-Za-z0-9_]{1,25}$/;
const VIDEO_RE = /^v?(\d+)$/i;
const CLIP_RE = /^[A-Za-z0-9_-]{1,100}$/;

function error(message) { return { isTwitch: true, url: null, error: message }; }
function result(url, type) { return { isTwitch: true, url, type }; }
function normalizeTwitchUrl(value) {
  let parsed;
  try { parsed = new URL(value); } catch { return { isTwitch: false, url: value }; }
  if (!['http:', 'https:'].includes(parsed.protocol) || !TWITCH_HOSTS.has(parsed.hostname.toLowerCase())) {
    return { isTwitch: false, url: value };
  }

  const host = parsed.hostname.toLowerCase();
  const parts = parsed.pathname.split('/').filter(Boolean);
  if (host === 'player.twitch.tv') {
    const video = parsed.searchParams.get('video');
    const channel = parsed.searchParams.get('channel');
    const clip = parsed.searchParams.get('clip');
    if (video) {
      const match = VIDEO_RE.exec(video);
      return match ? result('https://www.twitch.tv/videos/' + match[1], 'video') : error('معرّف فيديو Twitch غير صالح.');
    }
    if (channel) {
      return CHANNEL_RE.test(channel) ? result('https://www.twitch.tv/' + channel, 'channel') : error('اسم قناة Twitch غير صالح.');
    }
    if (clip) return CLIP_RE.test(clip) ? result('https://clips.twitch.tv/' + clip, 'clip') : error('رابط مقطع Twitch غير صالح.');
    return error('رابط مشغّل Twitch لا يحتوي channel أو video أو clip معروفًا.');
  }

  if (host === 'clips.twitch.tv') {
    const clip = parts[0] || parsed.searchParams.get('clip');
    return clip && CLIP_RE.test(clip) ? result('https://clips.twitch.tv/' + clip, 'clip') : error('رابط مقطع Twitch غير صالح.');
  }

  if (parts[0] === 'videos' && parts[1]) {
    const match = VIDEO_RE.exec(parts[1]);
    return match ? result('https://www.twitch.tv/videos/' + match[1], 'video') : error('معرّف فيديو Twitch غير صالح.');
  }
  if (parts[0] === 'clip' && parts[1]) {
    return CLIP_RE.test(parts[1]) ? result('https://clips.twitch.tv/' + parts[1], 'clip') : error('رابط مقطع Twitch غير صالح.');
  }
  if (parts.length >= 3 && parts[1].toLowerCase() === 'clip') {
    return CLIP_RE.test(parts[2]) ? result('https://clips.twitch.tv/' + parts[2], 'clip') : error('رابط مقطع Twitch غير صالح.');
  }
  if (parts.length === 1 && CHANNEL_RE.test(parts[0])) {
    return result('https://www.twitch.tv/' + parts[0], 'channel');
  }

  // Leave other Twitch URLs intact for yt-dlp to handle or reject normally.
  return { isTwitch: true, url: parsed.href, type: 'other' };
}

module.exports = { normalizeTwitchUrl };
