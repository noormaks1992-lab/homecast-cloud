'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeTwitchUrl } = require('./twitch-source');

test('normalizes an official Twitch channel player embed and drops the parent parameter', () => {
  const r = normalizeTwitchUrl('https://player.twitch.tv/?channel=majedobs2&muted=false&parent=live.example.com&autoplay=true');
  assert.deepEqual(r, { isTwitch: true, url: 'https://www.twitch.tv/majedobs2', type: 'channel' });
});

test('normalizes Twitch player VOD and clip embeds', () => {
  assert.equal(normalizeTwitchUrl('https://player.twitch.tv/?video=v123456&parent=example.com').url, 'https://www.twitch.tv/videos/123456');
  assert.equal(normalizeTwitchUrl('https://player.twitch.tv/?clip=GreatClip_123&parent=example.com').url, 'https://clips.twitch.tv/GreatClip_123');
  assert.equal(normalizeTwitchUrl('https://clips.twitch.tv/embed?clip=GreatClip_123&parent=example.com').url, 'https://clips.twitch.tv/GreatClip_123');
});

test('normalizes canonical channel, VOD and clip URLs', () => {
  assert.equal(normalizeTwitchUrl('https://www.twitch.tv/majedobs2').type, 'channel');
  assert.equal(normalizeTwitchUrl('https://www.twitch.tv/videos/98765?filter=all').url, 'https://www.twitch.tv/videos/98765');
  assert.equal(normalizeTwitchUrl('https://www.twitch.tv/majedobs2/clip/GreatClip').url, 'https://clips.twitch.tv/GreatClip');
});

test('reports malformed player links and leaves unrelated URLs unchanged', () => {
  assert.match(normalizeTwitchUrl('https://player.twitch.tv/?parent=example.com').error, /لا يحتوي/);
  const other = 'https://example.com/video';
  assert.deepEqual(normalizeTwitchUrl(other), { isTwitch: false, url: other });
});
