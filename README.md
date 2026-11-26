# Couchcast

Watch movies together with friends. One person hosts and plays a movie file from their computer; friends join with a room code or invite link and watch in sync. Video and voice go peer-to-peer (WebRTC via PeerJS), so there is no server to run and nothing to pay for.

**Live:** https://sanyam1121.github.io/couchcast/

## Features
- **Two ways to watch**: *Stream to friends* (the host's browser sends the movie) or *Everyone has the file* (each friend opens their own copy; only play/pause/seek is shared, full quality, almost no bandwidth).
- **Voice chat** with hold-to-talk (button, or hold **T**) or open mic. The movie dips automatically while anyone talks, and the speaker's name shows on screen.
- **Movie sound done right**: 5.1 surround is folded into stereo with the dialogue (centre) channel kept, plus a *Clearer dialogue* option. Friends get stereo high-bitrate sound.
- **Per-friend sound**: each friend can turn on clearer dialogue and add a sound delay if voices arrive before the picture.
- **TV mode**: full-screen layout with big controls for TV browsers and remotes (OK = play/pause, arrows = skip and volume, Back = exit). Smart-TV browsers switch to it automatically. The cast button explains casting a tab or opening Couchcast on the TV.
- **Room controls**: password for new people, lock the room, remove someone, hand host to a friend. If the host leaves or closes the tab, the longest-present friend takes over and the night carries on.
- **Queue and resume**: pick several files to make a queue; the next one starts with a countdown. Couchcast remembers where each movie was stopped and offers to resume. In *Everyone has the file* mode friends can pick a whole folder of episodes and their copy switches automatically.
- **Chat, reactions, subtitles** (.srt/.vtt shown to everyone), invite links, connection stats.
- **Install as an app** on phones and computers (Install button in the header; on iPhone: Share → Add to Home Screen).

## If a friend can't connect (stuck at "Connecting…")
Some networks (Jio, Airtel, mobile hotspots, office Wi-Fi) block direct connections between two devices. Couchcast now says so after 15 seconds instead of waiting forever. The fix is a relay server:
1. Make a free account at metered.ca (Open Relay: 20 GB a month free).
2. Copy your "TURN credentials" link (`https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=...`).
3. Paste it into `window.COUCHCAST_TURN_API` near the top of `index.html` so everyone gets it, or under "Connection settings" on the start page of each device.

## No sound, or bad sound?
- **Silent for everyone (host too):** many 4K movie files use AC3 / E-AC3 / DTS 5.1 audio, which browsers can't play. Convert just the audio to AAC (the video is copied, so it's quick and keeps 4K):
  ```
  ffmpeg -i movie.mkv -map 0:v:0 -map 0:a:0 -c:v copy -c:a aac -b:a 320k -ac 2 movie-fixed.mp4
  ```
- **Choppy sound for friends:** keep the host's Couchcast tab in front while streaming, and lower "Max quality per friend" if the host's upload is weak. Friends can click "Show connection stats" to see sound bitrate and gaps.
- **Voice chat echo:** use hold-to-talk, or wear headphones with open mic.

Use Chrome or Edge on a computer to host. Only stream movies you have the rights to share.
