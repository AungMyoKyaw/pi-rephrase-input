---
version: alpha
name: Pi Rephrase Input — Instrument Sheet
description: A precision-instrument specification sheet for a quiet input layer that sits in front of Pi.
omitted: []
colors:
  primary: "#131311"
  secondary: "#5e605b"
  tertiary: "#a83823"
  neutral: "#f4f0e8"
  rule: "#d8d2c4"
  panel: "#ebe5d7"
typography:
  display:
    fontFamily: Inter
    fontSize: 64px
    fontWeight: 600
    lineHeight: 1.02
    letterSpacing: -0.025em
  h2:
    fontFamily: Inter
    fontSize: 40px
    fontWeight: 600
    lineHeight: 1.05
    letterSpacing: -0.02em
  h3:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: -0.01em
  body:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 400
    lineHeight: 1.6
    letterSpacing: 0
  small:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.55
    letterSpacing: 0
  mono:
    fontFamily: "JetBrains Mono"
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.7
    letterSpacing: 0
  mono-strong:
    fontFamily: "JetBrains Mono"
    fontSize: 12px
    fontWeight: 500
    lineHeight: 1.7
    letterSpacing: 0
  eyebrow:
    fontFamily: "JetBrains Mono"
    fontSize: 11px
    fontWeight: 500
    lineHeight: 1
    letterSpacing: 0.08em
rounded:
  zero: "0px"
  sm: "4px"
spacing:
  0: "0px"
  1: "4px"
  2: "8px"
  3: "12px"
  4: "16px"
  5: "24px"
  6: "32px"
  7: "48px"
  8: "64px"
  9: "96px"
  10: "128px"
components:
  page-shell:
    backgroundColor: "{colors.neutral}"
    padding: "{spacing.9}"
    width: "1440px"
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
  button-accent:
    backgroundColor: "{colors.tertiary}"
    textColor: "{colors.neutral}"
    rounded: "{rounded.sm}"
  console:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.zero}"
  install-panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.zero}"
  cursor:
    backgroundColor: "{colors.tertiary}"
    rounded: "{rounded.zero}"
  caption:
    textColor: "{colors.secondary}"
  divider:
    backgroundColor: "{colors.rule}"
    height: "1px"
---

## Overview

This site reads like a precision-instrument specification sheet — the single-page document a watchmaker or optical-instrument maker ships with a product. The audience is a developer who already uses Pi and wants to know exactly what this extension changes and what it leaves alone. The substrate is plain static HTML, CSS, and a small JS file served from `site/`, with no build step and no framework. The posture is quiet: monochrome on warm paper, hairline rules as the dominant separator, one accent for the conversation voice, no decoration that does not earn its place.

## Colors

The palette is grayscale-on-paper plus one accent. Six named colors, each with one job.

- **Primary `#131311`** — A near-black ink. Headlines, primary text, the dark install CTA. Maximum readability against the paper.
- **Secondary `#5e605b`** — A warm slate. Captions, metadata, body copy in low-emphasis roles, the eyebrow over each section.
- **Tertiary `#a83823`** — A single brick red. The voice of conversation context and the cursor. Appears on no other surface. Passes WCAG AA on neutral for body-size text.
- **Neutral `#f4f0e8`** — A warm paper. The page surface. Softer than pure white; reads as ink on paper, not pixels on a screen.
- **Panel `#ebe5d7`** — A slightly darker paper. The console and install panels sit one tone below the page — depth by value, not by shadow.
- **Rule `#d8d2c4`** — Hairline divider color. Every section break in the page is this color, one pixel wide.

There is no second accent. No surface takes its own tint beyond neutral and panel.

## Typography

Two typefaces: **Inter** for prose, **JetBrains Mono** for technical detail. Display uses Inter, sized large with tight negative tracking. No italic display headings, no display serif, no monospace body. Mono is reserved for file paths, command strings, environment variable names, model identifiers, numeric values, and the content of the in-page console example.

- **Display** — Inter 64 / 60 weight, tracking -0.025em. The hero headline. One per page.
- **H2** — Inter 40 / 60 weight, tracking -0.02em. Section openers.
- **H3** — Inter 22 / 60 weight, tracking -0.01em. Card and step titles.
- **Body** — Inter 16 / 40 weight, line-height 1.6. Long-form copy.
- **Small** — Inter 13 / 40 weight, line-height 1.55. Captions and card descriptions.
- **Mono** — JetBrains Mono 12 / 40 weight. File paths, env vars, commands.
- **Mono-strong** — JetBrains Mono 12 / 50 weight. Identifiers that must read at a glance — the active model id, recent-history labels.
- **Eyebrow** — JetBrains Mono 11 / 50 weight, uppercase, tracking +0.08em. The label that sits above each section's title.

Italic exists in the body weight for inline term emphasis. It is never used in display or H2.

## Layout

Twelve-column grid on a 1440 max width. Ninety-six pixels of page margin on desktop, twenty-four on mobile. Vertical rhythm uses a four-pixel baseline; spacing tokens step in fours and eights (4, 8, 16, 24, 32, 48, 64, 96, 128). Sections separate with ninety-six to one hundred twenty-eight pixels of vertical air. The hero uses a two-column split — five columns of copy on the left, seven columns of console on the right. Below the hero, sections span the full width and let hairline rules do the work of separating content.

## Elevation & Depth

The page is flat. No drop shadows. No glass. No gradients. The console and install panels are one tone darker than the page — depth by value, not by surface effect. The only elevated moment is the cursor block in the console, which is rendered in the accent color and animates a single one-hertz blink.

## Shapes

Mostly square. Cards, the console, the install panel, and the command block all carry zero corner radius. Buttons carry a four-pixel radius. No pill shapes. No large rounded corners on any surface. The favicon is a fourteen-pixel-radius square.

## Components

- **Header.** Left: a brand mark — a small `›_` glyph in the accent, followed by the wordmark — and the package name. Right: navigation links and an external repo link. A one-pixel hairline rule underlines the header on every viewport.
- **Hero.** Two columns on desktop (left copy, right console), stacked on mobile. The display headline is the largest size on the page. The console reproduces a real input-to-rephrase transformation: the rough prompt at the top, recent conversation snippets in mono pills, the rephrased output below, and a blinking accent cursor as the only motion.
- **Proof line.** Four cells separated by hairline dividers. Each cell shows a monospace numeral and a short label. Reads like a spec sheet summary row.
- **Workflow.** Three numbered rows separated by hairline rules. Each row is a three-column grid: monospace numeral, title and description, a single mono symbol on the right.
- **Behavior contract.** A short list of guaranteed states — what the extension does when disabled, when input comes from another extension, how conversation context stays bounded, when project files are present, and when the rephrase times out. Each item is one line of mono caption followed by one sentence of body copy.
- **Configuration.** A flat, no-border table of env var names (mono) and their default values (mono, right-aligned). No zebra striping, no card chrome.
- **Install.** A paper panel containing one mono command line and a square copy button. Below the command, two smaller lines in mono offer the local-checkout alternative and a one-line verification.
- **Footer.** Brand mark on the left, repo link on the right, separated from the page by a hairline rule above.

## Do's and Don'ts

### Do

- Use hairline rules to separate sections, not whitespace alone.
- Keep the accent on the conversation voice only: the cursor, recent-history labels, the link hover, the install CTA.
- Use mono for every technical detail: file paths, command strings, env var names, model identifiers, numeric values.
- Use sans for narrative copy.
- Reproduce real product behavior in the console example — the rough prompt at the top, recent conversation in the middle, the rephrased output at the bottom.
- Honour `prefers-reduced-motion`: the cursor still blinks; reveal-on-scroll becomes instant.

### Don't

- Don't add a second accent. There is one accent and it has one job.
- Don't use gradients, glow, drop shadows, glassmorphism, or blur effects anywhere.
- Don't use pill-shaped buttons or large rounded corners. The system is square by default.
- Don't use italic display headings. Italic appears only in body text for inline term emphasis.
- Don't use emoji or decorative glyphs beyond the simple monospace symbols (`›`, `↳`, `⌘`, `◎`) the terminal already uses.
- Don't add a dark-mode override. The site is light by design decision, not by accident.
- Don't add a hero illustration, an image-heavy hero, or background art. The console carries the visual weight.
- Don't add third-party fonts beyond Inter and JetBrains Mono, and don't add tracking, analytics, or marketing scripts.
- Don't claim product behavior not present in the README or the extension source. Numbers, defaults, and limits come from the code.