# Jarvis on your phone (Expo)

The app shows the Jarvis website's own interface full screen (chat, voice,
approvals, files), so it always matches the site. On top of that it adds
phone notifications, the microphone, and opening texts, calls and other apps.

## Run it in Expo Go

From this folder, once:

    npm.cmd run setup

Then each time (phone on the same Wi-Fi):

    npx.cmd expo start --lan

Scan the QR code with the iPhone Camera app, then sign in with your Jarvis
password. Changes to the website show up in the app straight away; only
changes to this folder need the command above again.

## Notifications

Reminders, routine answers and finished laptop jobs become phone
notifications while the app is open. For notifications when it is fully
closed, run `npx.cmd eas init` once (works in Expo Go on iPhone).
