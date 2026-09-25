import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// The whole point of this app being a PWA rather than a native build is
// installability without an app store — manifest below is what makes
// "Install app" show up in Chrome/Edge on both desktop and Android, and
// "Add to Home Screen" work sanely on iOS Safari.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      // Two installable apps from one site: the customer app
      // (public/manifest.webmanifest, scope "/") and the admin app
      // (public/admin.webmanifest, scope "/admin"). index.html picks
      // which manifest to link based on the URL, so each can be added
      // to the home screen separately with its own name and icon.
      manifest: false,
      // Push notification handlers live in public/push-sw.js.
      workbox: { importScripts: ['/push-sw.js'] },
      includeAssets: ['push-sw.js', 'icon.svg', 'icon-192.png', 'icon-512.png', 'admin-icon-192.png', 'admin-icon-512.png', 'manifest.webmanifest', 'admin.webmanifest'],
    }),
  ],
  server: {
    port: 5173,
  },
  // Force-rebuild marker: 1789564412851
});
