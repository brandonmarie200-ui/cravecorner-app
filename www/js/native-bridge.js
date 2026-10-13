/* CraveCorner native bridge — APP WRAPPER BUILD ONLY.
 * This file does nothing on the website. It only activates inside the
 * Capacitor iOS wrapper (window.Capacitor.isNativePlatform()).
 *
 * What it wires up:
 *  1. Haptic tap feedback — buttons feel instant/native instead of "a hair slow".
 *  2. Native push notifications — registers the APNs device token with the
 *     existing cc_push_subscriptions table (endpoint prefixed "apns:").
 *  3. CC.native.takePhoto() / CC.native.locate() — real camera + GPS helpers
 *     the site can call later for food photos and nearby search.
 */
(function () {
  'use strict';

  function isNative() {
    try {
      return !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                window.Capacitor.isNativePlatform());
    } catch (e) { return false; }
  }
  if (!isNative()) return;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('failed: ' + src)); };
      document.head.appendChild(s);
    });
  }

  var PLUGINS = [
    'js/cap-plugins/push-notifications.js',
    'js/cap-plugins/haptics.js',
    'js/cap-plugins/camera.js',
    'js/cap-plugins/geolocation.js'
  ];

  function saveNativeToken(token) {
    // The user may not be logged in yet — retry until CC + Supabase + user exist.
    var tries = 0;
    (function attempt() {
      tries++;
      try {
        if (window.CC && CC.sb && CC.user && CC.user.id) {
          CC.sb.from('cc_push_subscriptions').upsert(
            {
              user_id: CC.user.id,
              endpoint: 'apns:' + token,
              p256dh: 'apns',          // placeholder: native tokens have no web-push keys
              auth: 'apns',
              user_agent: 'CraveCorner iOS'
            },
            { onConflict: 'user_id,endpoint' }
          ).then(function () {}).catch(function () {});
          return;
        }
      } catch (e) {}
      if (tries < 40) setTimeout(attempt, 3000);
    })();
  }

  function init() {
    try {
      // 1. Haptics — light tap on every click. This is the "feels like an app" fix.
      var Haptics = window.capacitorHaptics && window.capacitorHaptics.Haptics;
      if (Haptics && Haptics.impact) {
        document.addEventListener('click', function () {
          try { Haptics.impact({ style: 'LIGHT' }); } catch (e) {}
        }, { passive: true });
      }

      // 2. Native push registration.
      var Push = window.capacitorPushNotifications &&
                 window.capacitorPushNotifications.PushNotifications;
      if (Push) {
        Push.requestPermissions().then(function (perm) {
          if (perm && perm.receive === 'granted') { Push.register(); }
        }).catch(function () {});
        Push.addListener('registration', function (t) {
          if (t && t.value) { saveNativeToken(t.value); }
        });
        Push.addListener('registrationError', function () {});
        // Quiet handlers so notifications don't crash the webview.
        Push.addListener('pushNotificationReceived', function () {});
        Push.addListener('pushNotificationActionPerformed', function () {});
      }

      // 3. Native helpers for future use.
      window.CC = window.CC || {};
      window.CC.native = {
        takePhoto: function () {
          var Camera = window.capacitorCamera && window.capacitorCamera.Camera;
          if (!Camera) { return Promise.reject(new Error('camera unavailable')); }
          return Camera.getPhoto({ quality: 85, allowEditing: false, resultType: 'DATA_URL' });
        },
        locate: function () {
          var Geo = window.capacitorGeolocation && window.capacitorGeolocation.Geolocation;
          if (!Geo) { return Promise.reject(new Error('location unavailable')); }
          return Geo.getCurrentPosition({ enableHighAccuracy: true, timeout: 10000 });
        }
      };
    } catch (e) {}
  }

  var chain = Promise.resolve();
  PLUGINS.forEach(function (src) {
    chain = chain.then(function () { return loadScript(src); });
  });
  chain.then(init).catch(function () { /* webview stays fully usable without plugins */ });
})();
