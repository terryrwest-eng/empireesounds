# Empire Sounds — site

Static one-pager. No build step, no framework, no dependencies.

Also hosts **[Station](station/)** (`/station/`) — a GPS stationing app for field
crews, with an NTRIP relay for RTK corrections mounted at `/ntrip/`. Separate
app, same server, no dependencies either. See
[`station/README.md`](station/README.md) for the relay's environment variables
and how it is fenced.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. Nothing to configure. Nixpacks sees `package.json`, runs `npm start`, which runs `server.js`.
4. Settings → Networking → Generate Domain for the `*.up.railway.app` URL.

Runs locally the same way: `node server.js`, then open `http://localhost:3000`.

## Before it goes public — swap the placeholder domain

`REPLACE-WITH-DOMAIN` appears in three files. Find and replace all of them once the Railway URL exists, or the social preview and sitemap point nowhere.

- `index.html` — canonical, `og:url`, `og:image`, `twitter:image`
- `robots.txt`
- `sitemap.xml`

## Owner needs to sign off on these

Written from evidence in the Google reviews, not from anything he said. All plausible, none confirmed:

- "Same day on most installs" — hero
- "Walk-ins welcome" — visit section
- "Sealed, ported, and custom builds" and the rest of the services grid
- Whether alarms, remote start, and lighting are actually offered
- The four review excerpts (shortened from Google, full text linked)
- All five reviews are marked 5-star — inferred from the 4.8 average, not verified per review

## Still empty

- **Hero photo** is the Tesla Model 3 build. Not the shop's work. Swap for one of theirs at launch, or keep it with a credit line — but don't leave it uncredited on a live site.
- **Three 4:3 slots** in "Behind the panel" — wiring detail, finished dash, sub enclosure
- **Two 3:4 slots** in the custom-fit section — door build, amp rack
- **Fifth review** — styled as an open dashed card so it reads as intentional, not broken

Shot list that matters for this trade: a door card off with wiring visible, a finished dash with the screen lit, an amp rack, and the storefront in daylight.

## What's already wired

- Real address, phone, hours; `tel:` links throughout
- Embedded Google map
- Google review links via place ID — both "read all" and "leave a review"
- JSON-LD `AutoPartsStore` structured data (name, address, geo, hours, phone)
- Open Graph and Twitter cards with a 1200×630 image, so texted links preview properly
- Today's hours highlight automatically
- Responsive to mobile, visible keyboard focus, `prefers-reduced-motion` respected

## Files

```
index.html        the site
server.js         static server, no dependencies
package.json      start script
favicon.svg
og.jpg            1200x630 social card
robots.txt
sitemap.xml
empire-sounds-tesla-4x3.jpg      hero (currently used)
empire-sounds-tesla-wide.jpg     16:9 alternate
empire-sounds-tesla-original.jpg untouched original
```
