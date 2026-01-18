# Org Calendar Android App

A simple WebView wrapper for the Org Calendar web application.

## Prerequisites

- Android Studio (or just Gradle CLI)
- Your Org Calendar server running on a Linux machine

## Building

### Using Android Studio
1. Open this `android` folder in Android Studio
2. Build > Build Bundle(s) / APK(s) > Build APK(s)
3. Find APK in `app/build/outputs/apk/debug/`

### Using Command Line
```bash
cd android
./gradlew assembleDebug
# APK will be at app/build/outputs/apk/debug/app-debug.apk
```

### Release Build (for F-Droid)
```bash
./gradlew assembleRelease
```

## Setup

1. Install the APK on your Android device
2. Open the app
3. Enter your server URL (e.g., `http://192.168.1.100:8766`)
4. Tap "Connect"

## Features

- Connects to your self-hosted Org Calendar server
- Remembers server URL
- Settings button (gear icon) to change server
- Full PWA features via WebView
- Dark theme matching the web app

## Network Access

The app needs to reach your Linux server. Options:

1. **Local Network**: Phone and server on same WiFi
2. **Tailscale/ZeroTier**: VPN for remote access
3. **Reverse Proxy**: Expose via nginx + HTTPS (for internet access)

## F-Droid Submission

This app is designed to be F-Droid compatible:
- No proprietary dependencies
- Simple build process
- Open source

To submit:
1. Fork the F-Droid Data repository
2. Add metadata in `metadata/org.orgcalendar.yml`
3. Submit merge request
