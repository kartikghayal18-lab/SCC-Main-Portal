# Auto Clicker Demo

Simple Android demo app that uses an accessibility service plus a floating overlay to dispatch repeated taps at the overlay target location.

## What it does

- lets you set a tap interval in milliseconds
- opens overlay permission and accessibility settings
- shows a draggable floating panel
- taps repeatedly at the center of the floating target while running

## How to use

1. Open the project in Android Studio.
2. Let Gradle sync.
3. Run the app on a real Android device.
4. Grant overlay permission.
5. Enable the app's accessibility service in system settings.
6. Show the floating overlay and drag the red target where you want taps.
7. Press `Start auto tap`.

## Notes

- Works only on Android because it relies on `AccessibilityService.dispatchGesture`.
- Some apps or games may block overlays or accessibility-driven gestures.
- This is a minimal demo and does not include multiple targets or gesture recording.
