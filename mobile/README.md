# Jarvis on your phone (Expo)

Chat with Jarvis, approve what he does on your laptop, get reminders as
notifications, and **Call** him (his voice, hands-free).

## Run it in Expo Go

From this folder, once:

    npm run setup

Then each time:

    npm start

Scan the QR code with your phone's camera (iPhone) or with Expo Go (Android),
sign in with your Jarvis password, and that's it.

## Notifications

- **While the app is open or was just used**, Jarvis checks every 20 seconds
  and shows reminders, routine answers and finished laptop jobs as
  notifications. This works in Expo Go straight away.
- **Real push** (when the app is fully closed) needs an Expo project id, once:

      npx eas init

  On iPhone that works in Expo Go. On Android, Expo Go cannot receive push
  any more; it needs your own build (`npx eas build -p android --profile preview`,
  free) installed instead of Expo Go.
