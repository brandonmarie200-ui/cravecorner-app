import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.cravecorner.app',
  appName: 'CraveCorner',
  webDir: 'www',

  // Match the site's Vanilla Cream background so the launch never flashes white.
  backgroundColor: '#FFF9F3',

  ios: {
    // Fullscreen app feel; the PWA already handles its own layout.
    contentInset: 'always',
  },

  plugins: {
    SplashScreen: {
      launchShowDuration: 1500,
      launchAutoHide: true,
      backgroundColor: '#FFF9F3',
      showSpinner: false,
      iosSpinnerStyle: 'large',
    },
    StatusBar: {
      style: 'DARK',
      backgroundColor: '#FFF9F3',
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
