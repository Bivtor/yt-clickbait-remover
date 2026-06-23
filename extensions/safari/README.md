# Safari Extension

Safari extensions are converted from the Chrome extension using Apple's Xcode toolchain.
You need a paid Apple Developer account ($99/year) to distribute via the App Store.

## Steps (when ready)

1. Install Xcode from the Mac App Store.

2. Convert the Chrome extension:
   ```bash
   xcrun safari-web-extension-converter ../chrome \
     --project-location . \
     --app-name "De-Clickbait" \
     --bundle-identifier "com.yourname.declickbait"
   ```
   This generates an Xcode project in the current directory.

3. Open the generated `.xcodeproj` in Xcode, build, and run.

4. Enable unsigned extensions for testing:
   Safari → Settings → Advanced → "Show Develop menu"
   Develop → "Allow Unsigned Extensions"

5. For distribution: archive in Xcode and submit to the App Store via App Store Connect.

## Notes
- Safari MV3 support is solid as of Safari 16+.
- The converter handles manifest differences automatically.
- Do this step last — do Firefox/Chrome dev first, then convert when the extension is stable.
