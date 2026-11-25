# Couchcast

Watch movies together with friends. One person hosts and plays a movie file from their computer; friends join with a room code or invite link and watch in sync, with chat, reactions and subtitles. Video goes peer-to-peer (WebRTC via PeerJS), so there is no server to run and nothing to pay for.

**Live:** https://sanyam1121.github.io/couchcast/

## Modes
- **Stream to friends**: the host's browser streams the movie to each friend. Quality depends on the host's upload speed (4K needs ~20–40 Mbps per friend).
- **Everyone has the file**: each friend opens their own copy; only play/pause/seek is synced. Full quality, almost no bandwidth.

## If a friend can't connect
Some networks (mobile data, strict routers) block direct connections. Add a TURN relay (for example a free metered.ca account) in `window.COUCHCAST_TURN` near the top of `index.html`, or under "Connection settings" on the start page.

Use Chrome or Edge. Only stream movies you have the rights to share.

## No sound, or bad sound?
- **Silent for everyone (host too):** many 4K movie files use AC3 / E-AC3 / DTS 5.1 audio, which browsers can't play. Convert just the audio to AAC (the video is copied, so it's quick and keeps 4K):
  ```
  ffmpeg -i movie.mkv -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 320k -ac 2 movie-fixed.mp4
  ```
- **Choppy sound for friends:** keep the host's Couchcast tab in front while streaming, and lower "Max quality per friend" if the host's upload is weak. Friends can click "Show connection stats" to see sound bitrate and gaps.
