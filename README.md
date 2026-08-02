# Empire Sounds — site

Static one-pager. No build step, no framework, no dependencies.

`node server.js`, then open `http://localhost:3000`.

## Deploy to Railway

1. Push this folder to a GitHub repo.
2. Railway → New Project → Deploy from GitHub repo.
3. Nothing to configure. Nixpacks sees `package.json`, runs `npm start`, which runs `server.js`.
4. Settings → Networking → Generate Domain for the `*.up.railway.app` URL.

## Read this before adding photos back

Four images were removed from the site because they are not photographs of
this shop's work:

| File | Why it went |
| --- | --- |
| `door-pod.jpg` | Four-point sparkle watermark in the bottom-right corner — Google's marker for an AI-generated image |
| `door-build.jpg` | Same watermark. The panel label reads "DOOR BUILD // HIGH-OUTPUT ENCLOSURE", which is generator text, not a real part |
| `amp-rack.jpg` | Same watermark. The amplifier plaque reads "Q-AMP NEROW / SOLARIS 2.1" — the giveaway pseudo-lettering these tools produce |
| `sub-enclosure.jpg` | No watermark, but a studio-lit press shot of an Audi with manufacturer branding. Not shop-floor documentation |

They are still in git history if any of that is wrong — `git checkout
HEAD~1 -- <file>` brings one back. If `sub-enclosure.jpg` really is a
job this shop did, say so and it goes back in.

A car audio shop showing generated installs as its portfolio is the one
mistake a customer cannot forgive, and in California it is also false
advertising under Bus. & Prof. Code § 17500. Do not put an image on this
site that nobody at the shop took.

**What to shoot instead**, in rough order of value: a door card off with
the wiring visible, a finished dash with the screen lit, an amp rack, a
trunk enclosure, and the storefront in daylight. A phone photo of real
work beats a perfect fake every time — `hero.jpg` is exactly that and it
is the strongest thing on the page.

## Pricing

There are no dollar figures on the site. The pricing section explains how
quoting works — free, written, quoted before anything comes apart — which
is the part customers actually want to know.

A ready-made price table sits commented out in `index.html`, directly below
the `#pricing` section. Replace each `000` with a real number, delete the
comment wrapper and any row that doesn't apply. Until then it stays off,
because a made-up number on a live site is a number a customer will hold
you to.

## Owner contact

Terry West is named on the page as owner, with a direct line and email in
the Visit section, the footer, and the JSON-LD. Shop line `(951) 605-2352`
is unchanged and still the primary number everywhere — the direct line is
additive, for customers who have already been in.

## Facts that live in more than one place

Change one, change all of them:

| Fact | Where |
| --- | --- |
| Shop phone `(951) 605-2352` | meta description, header button, hero, Visit, footer, JSON-LD `telephone` and `contactPoint` |
| Direct line `(951) 639-7054` | Visit owner card, JSON-LD `founder` and `contactPoint` |
| Email | Visit info list, Visit owner card, footer, JSON-LD `email` and `founder` |
| Address | Visit, footer, map iframe, JSON-LD, both map links |
| Hours | Visit list and JSON-LD `openingHoursSpecification` |
| Areas served | Visit "Areas served" chips and JSON-LD `areaServed` — these two were out of sync until now |
| `4.8 from 75 reviews` | stat bar and Reviews lede, dated on the page so it reads as a snapshot |

The rating and count are deliberately no longer in the title, meta
description, or social cards. That was five copies of a number that goes
stale every time somebody leaves a review.

## Owner still needs to confirm

Written from evidence in the Google reviews, not from anything the shop said:

- "Same day — ask when you call" (softened from "on most installs")
- "Walk-ins welcome"
- The services grid contents
- Whether alarms, remote start, and lighting are offered at all
- The four review excerpts, shortened from Google

## Worth doing next

- **Buy a domain.** `empireesounds-production.up.railway.app` reads as a
  test deployment. A real domain is the cheapest credibility on this list.
  It appears in `index.html` (canonical, `og:url`, `og:image`,
  `twitter:image`, JSON-LD `url` and `image`), `robots.txt`, and
  `sitemap.xml`.
- Real photos, per the section above.
- A warranty line, if there is one. "Workmanship guaranteed for N days"
  converts.
- Whether the shop is licensed/insured, and payment methods accepted.

## What's already wired

- Real address, phone, hours; `tel:` and `mailto:` links throughout
- Embedded Google map
- Google review links via place ID — both "read all" and "leave a review"
- JSON-LD `AutoRepair` structured data (was `AutoPartsStore`, which
  described a parts counter this shop does not run) with name, address,
  geo, hours, phone, email, owner, and areas served
- Open Graph and Twitter cards with a 1200×630 image, so texted links preview properly
- Today's hours highlight automatically
- Responsive to mobile, visible keyboard focus, `prefers-reduced-motion` respected

## Files

```
index.html        the site
server.js         static server, no dependencies
package.json      start script
favicon.svg
hero.jpg          hero photo — real, shot in the bay
og.jpg            1200x630 social card, cropped from the same photo
empire-sounds-tesla-original.jpg  untouched original
Anton-Regular.ttf display face
robots.txt
sitemap.xml
```
