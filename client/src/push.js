// Push notifications on the device.
//
// Only does anything inside the packaged Capacitor app — a browser has no FCM
// token, so every function here is a no-op on the web and the app behaves exactly
// as before. That keeps `npm run dev` working with no Firebase setup at all.
import { api } from "./api";
import { isNativeApp } from "./PhoneShell";

// The plugin is imported lazily. Importing it at unit scope would pull native
// bindings into the web bundle for no reason.
async function plugin() {
  if (!isNativeApp()) return null;
  try {
    const mod = await import("@capacitor/push-notifications");
    return mod.PushNotifications || null;
  } catch (_) {
    return null;
  }
}

// Remember the token so sign-out can unregister exactly this device.
const TOKEN_KEY = "edtech_push_token";
export const getDeviceToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch (_) { return null; } };
const rememberToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch (_) {} };

function platform() {
  if (typeof window === "undefined") return "web";
  const p = window.Capacitor?.getPlatform?.();
  return p === "ios" || p === "android" ? p : "web";
}

let listenersAttached = false;

/**
 * Ask for permission, register with FCM/APNs, and hand the token to the server.
 * Call once the user is signed in — registering earlier would give us a token
 * with no account to attach it to.
 *
 * onOpen(link) fires when a notification is tapped, so the app can jump to the
 * relevant screen.
 */
export async function registerForPush({ onOpen } = {}) {
  const Push = await plugin();
  if (!Push) return { supported: false };

  try {
    // On iOS this shows the system prompt; on Android 13+ it shows the runtime
    // POST_NOTIFICATIONS prompt. Older Android grants it at install time.
    let perm = await Push.checkPermissions();
    if (perm.receive === "prompt" || perm.receive === "prompt-with-rationale") {
      perm = await Push.requestPermissions();
    }
    if (perm.receive !== "granted") return { supported: true, granted: false };

    if (!listenersAttached) {
      listenersAttached = true;

      // Fired once FCM/APNs issues a token for this install.
      await Push.addListener("registration", async (t) => {
        const token = t?.value;
        if (!token) return;
        rememberToken(token);
        try { await api.registerDevice(token, platform()); }
        catch (e) { console.warn("[push] could not register the device with the server:", e.message); }
      });

      await Push.addListener("registrationError", (e) => {
        console.warn("[push] registration failed:", e?.error || e);
      });

      // Tapped from the notification shade / lock screen.
      await Push.addListener("pushNotificationActionPerformed", (action) => {
        const link = action?.notification?.data?.link;
        if (link && onOpen) onOpen(link);
      });
    }

    await Push.register();
    return { supported: true, granted: true };
  } catch (e) {
    console.warn("[push] setup failed:", e.message);
    return { supported: true, granted: false, error: e.message };
  }
}

/**
 * Stop this device receiving notifications for the account signing out. Without
 * it, a shared phone would keep buzzing with the previous user's leave decisions.
 */
export async function unregisterForPush() {
  const token = getDeviceToken();
  if (!token) return;
  // Tell the server first — after sign-out the request would be unauthenticated.
  try { await api.unregisterDevice(token); } catch (_) { /* best effort */ }
  rememberToken(null);
}
