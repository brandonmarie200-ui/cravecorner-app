# CraveCorner — App Store Wrapper (ready to ship)

The complete iOS wrapper for CraveCorner. Everything is built and configured —
when Marissa is ready, the only remaining steps are: pay the $99 Apple Developer
fee, run the Mac build, and submit.

## What this is

A Capacitor wrapper around the CraveCorner website. The app bundles the site's
files (in `www/`) and runs them fullscreen in a native iOS shell, with real
native features wired in:

- **App icon + splash screen** — generated from her logo (assets/img/logo-cc.jpg),
  splash on Vanilla Cream #FFF9F3 to match the brand.
- **Haptic tap feedback** — light native click on every button press. This is the
  fix for the "hair slow" tap feel she noticed in the Home Screen version.
- **Native push notifications** — registers the APNs device token into the
  existing `cc_push_subscriptions` table (endpoint prefixed `apns:`).
- **Camera + GPS helpers** — `CC.native.takePhoto()` / `CC.native.locate()`
  available for food photos and nearby search (wired, ready to call from the site).
- **Info.plist usage strings** — camera, photo library, and location prompts
  written in plain language (Apple requires these).
- **Service worker correctly skipped** in the native build (web version untouched).

The website source in `~/workspace/cravecorner/` was NOT modified. All wrapper
changes live in `www/` (a copy) plus this project's config.

## Bundle ID

`com.cravecorner.app` — set in `capacitor.config.ts` and the Xcode project.
⚠️ The bundle ID is permanent once the app record is created in App Store
Connect. Change it now (in both places) if she wants a different one.

## Remaining steps (needs a Mac — hers, a friend's, or a free cloud Mac build)

1. Pay the **$99/year Apple Developer Program** fee, enroll as an individual.
2. On the Mac: `cd ios/App && pod install` (CocoaPods — Mac only).
3. Open `ios/App/App.xcworkspace` in Xcode (NOT the .xcodeproj).
4. In Signing & Capabilities: select her Team, enable **Push Notifications**.
5. Create the App ID `com.cravecorner.app` + APNs key in the developer portal.
6. Product → Archive → Distribute → App Store Connect → TestFlight.
7. In App Store Connect: fill in the listing (screenshots, description, category:
   Food & Drink), submit for review (typically 1–3 days).

## Later: sending the native pushes (server side)

The app already saves APNs tokens to `cc_push_subscriptions` (rows with
`endpoint` starting `apns:`). To actually deliver them, the push sender needs an
APNs branch: for `apns:` endpoints, send via Apple's HTTP/2 API with the APNs
key from step 5 instead of web-push/VAPID. The existing `cc_push_queue` table
and sender cron stay as-is otherwise.

## Later: monthly payments / monetization

⚠️ Apple takes **15–30%** of in-app purchases and digital subscriptions.
Food orders themselves are physical goods (different rules — external payment
allowed), but a "seller subscription" sold inside the app would go through
Apple's system with their cut. Design decision for later: sell subscriptions on
the website (no Apple cut) and keep the app as the free companion, or accept
the cut for in-app convenience. Nothing to decide today.
