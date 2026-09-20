// YouTube Data API v3: reads your channel's public uploads.
// Every channel has an "uploads" playlist whose ID is the channel ID with the "UC" prefix swapped for "UU".
// Listing it via playlistItems costs 1 quota unit per page (search.list would cost 100).
import { cfg } from './config.js';

const CACHE_MS = 15 * 60 * 1000;
let cache = { at: 0, videos: [] };

// With an API key we read the whole catalog through the YouTube Data API. Without one we fall back to the channel's
// public RSS feed (its 15 newest videos), which needs no key, so the site works before Google Cloud is set up.
export const youtubeReady = () => cfg.devMock || Boolean(cfg.youtubeChannelId);
export const youtubeMode = () => (cfg.devMock ? 'demo' : !cfg.youtubeChannelId ? 'off' : cfg.youtubeKey ? 'api' : 'feed');

function mockVideos() {
  const titles = ['Midnight Drive', 'Golden Hour', 'Static Hearts', 'Paper Planes', 'Low Light', 'Wildfire', 'Slow Motion', 'Blue Room', 'Afterglow'];
  return titles.map((title, i) => ({
    id: `mock${String(i).padStart(7, '0')}`,
    title: `${title} (demo)`,
    thumb: null,
    publishedAt: new Date(Date.now() - i * 7 * 864e5).toISOString(),
  }));
}

function bestThumb(thumbnails = {}) {
  return (thumbnails.maxres || thumbnails.standard || thumbnails.high || thumbnails.medium || thumbnails.default || {}).url || null;
}

const decodeXml = (s) =>
  s.replace(/&(amp|lt|gt|quot|apos|#39);/g, (_, e) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'" })[e]);

/** Keyless fallback: the channel's public Atom feed (newest 15 uploads). */
async function fetchFeed() {
  const res = await fetch(`https://www.youtube.com/feeds/videos.xml?channel_id=${cfg.youtubeChannelId}`, {
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`YouTube feed returned ${res.status}. Check YOUTUBE_CHANNEL_ID.`);
  const xml = await res.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)]
    .map(([, entry]) => ({
      id: /<yt:videoId>([^<]+)</.exec(entry)?.[1],
      title: decodeXml(/<title>([^<]*)<\/title>/.exec(entry)?.[1] || ''),
      thumb: /<media:thumbnail url="([^"]+)"/.exec(entry)?.[1] || null,
      publishedAt: /<published>([^<]+)</.exec(entry)?.[1] || '',
    }))
    .filter((v) => v.id);
}

/** Drop #Shorts so weekly picks are full songs, unless that would leave too few to fill a drop. */
function withoutShorts(videos) {
  if (cfg.includeShorts) return videos;
  const songs = videos.filter((v) => !/#shorts?\b/i.test(v.title));
  return songs.length >= cfg.songsPerDrop ? songs : videos;
}

async function fetchUploads() {
  const channelId = cfg.youtubeChannelId;
  if (!/^UC[\w-]{20,}$/.test(channelId)) {
    throw new Error('YOUTUBE_CHANNEL_ID must be a channel ID starting with "UC" (not an @handle).');
  }
  if (!cfg.youtubeKey) return fetchFeed();
  const playlistId = 'UU' + channelId.slice(2);
  const videos = [];
  let pageToken = '';
  while (videos.length < cfg.youtubeMaxVideos) {
    const url = new URL('https://www.googleapis.com/youtube/v3/playlistItems');
    url.search = new URLSearchParams({
      part: 'snippet,contentDetails,status',
      playlistId,
      maxResults: '50',
      key: cfg.youtubeKey,
      ...(pageToken && { pageToken }),
    });
    const res = await fetch(url);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`YouTube API ${res.status}: ${data.error?.message || 'request failed'}`);
    for (const item of data.items || []) {
      if (item.status?.privacyStatus !== 'public') continue; // skips private/deleted entries
      videos.push({
        id: item.contentDetails.videoId,
        title: item.snippet.title,
        thumb: bestThumb(item.snippet.thumbnails),
        publishedAt: item.contentDetails.videoPublishedAt || item.snippet.publishedAt,
      });
    }
    pageToken = data.nextPageToken;
    if (!pageToken) break;
  }
  return videos.slice(0, cfg.youtubeMaxVideos);
}

/** All public uploads, newest first. Cached; serves stale data if YouTube is unreachable. */
export async function getUploads() {
  if (cfg.devMock) return mockVideos();
  if (!youtubeReady()) throw new Error('Set YOUTUBE_CHANNEL_ID (and optionally YOUTUBE_API_KEY) to load videos.');
  if (Date.now() - cache.at < CACHE_MS && cache.videos.length) return cache.videos;
  try {
    const videos = withoutShorts(await fetchUploads());
    cache = { at: Date.now(), videos };
    return videos;
  } catch (err) {
    if (cache.videos.length) {
      console.error('[youtube] using stale cache:', err.message);
      return cache.videos;
    }
    throw err;
  }
}

export const videoUrl = (id) => `https://www.youtube.com/watch?v=${id}`;
