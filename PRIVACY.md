# Face Value Privacy Policy

**Effective date:** July 5, 2026

Face Value is a browser extension that rewrites YouTube titles and replaces thumbnails
with real frames from the video. This page lists what the extension sends, what is
stored, and for how long.

The web version of this policy lives at https://facethevalue.com/privacy (keep the two
in sync; the store listings link there).

## The short version

- There are no accounts, sign-ins, or user identifiers. Requests cannot be linked to
  you, to each other, or to your YouTube account.
- The extension sends the video IDs, titles, and channel names of videos that appear
  on YouTube pages you view. Nothing else leaves your browser.
- Your settings are stored locally in your browser and are never transmitted.
- There is no analytics, advertising, or tracking code in the extension or on the
  website.
- No data is sold or shared for marketing.

## What the extension sends, exactly

When a YouTube page shows video cards, the extension sends one batched request to our
API containing, for each video on the page:

| Field | Example | Purpose |
|---|---|---|
| Video ID | `dQw4w9WgXcQ` | Look up or generate the rewritten title and thumbnail |
| Video title | `You WON'T BELIEVE…` | Fallback input for the rewrite; titles are independently verified against YouTube's public oEmbed API |
| Channel name | `Some Channel` | Context for the rewrite |

That is the entire payload. No YouTube account information, cookies, watch history,
search queries, page URLs, or identifiers of any kind are sent. The extension also
loads replacement thumbnail images from our CDN, which is an ordinary image request.

Like every request on the internet, these requests arrive with your IP address. See
"Server logs" below for how long that exists.

## What we store

**On our servers:** public video metadata only. Video IDs, original titles, channel
names, rewritten titles, and extracted thumbnail frames. This cache is shared by all
users and keyed by video, not by person. It contains no user data and is retained
indefinitely, since it is a cache of public information about public videos.

**Server logs:** the API keeps standard access logs (IP address, request time, request
path, response code) for 30 days, for abuse prevention and debugging. They are deleted
automatically after that. They are not used to build profiles and are not linked to
the cached video data.

**In your browser only** (via extension storage, never transmitted):

- Your toggle settings (titles on/off, thumbnails on/off, hide Shorts).
- Your channel exceptions list.
- A local tally of titles cleaned, kept as an offline fallback for the popup's counter.

Uninstalling the extension deletes all of it.

The counter shown in the popup is the global total of titles cleaned across all users.
The popup fetches that single aggregate number from our API when opened; the request
carries no data about you.

## Third-party services

Our servers (not your browser) talk to a few services to build the shared cache. What
they receive is public video metadata only:

- **YouTube** (oEmbed and video streams), to verify titles and extract thumbnail
  frames.
- **A transcript service**, to fetch the video's public captions.
- **Anthropic (Claude)**, which receives the video title, channel name, and transcript
  excerpt to generate the rewritten title.
- **Amazon Web Services**, which hosts the API, cache, and CDN.

Your browser talks to exactly two places: youtube.com, which you were already on, and
our API/CDN. The extension's fonts and assets are bundled, so it makes no requests to
Google Fonts or any other third party.

## What we can and cannot see

Because requests carry no identifier, we cannot tell which requests came from the same
person, reconstruct anyone's viewing history, or connect any request to a YouTube
account. An IP address in a 30-day access log is the only thing that could group
requests, and we do not use it that way.

We can see, in aggregate and anonymously, which videos are being looked up. That is
the cache working as intended.

## Permissions the extension requests

- **Access to youtube.com pages**, required to read video cards and swap titles and
  thumbnails in place.
- **Access to our API endpoint**, required to fetch rewrites and frames.
- **Storage**, required to save your settings locally.

Nothing else. No tabs, no history, no cookies, no "read data on all websites."

## Children

Face Value does not knowingly collect personal information from anyone, including
children. It has no accounts and no data collection beyond what is described above.

## Changes to this policy

If the extension's data behavior ever changes, this document will be updated and the
change will be called out in the release notes before it ships.

## Contact

Questions or concerns: open an issue on the project's repository, or email
**contact@carpinteriacws.com**.
