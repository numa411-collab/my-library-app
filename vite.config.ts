// vite.config.ts（プロジェクト直下）
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      // 起動中も自動で新バージョンを取りに行く
      registerType: "autoUpdate",

      // ここで PWA のメタ情報（ホーム追加の名前・色・アイコン）を定義
      manifest: {
        name: "Numata Lab Library App",
        short_name: "LibraryApp",
        start_url: ".",           // ルートから開始（サブパス運用なら調整）
        display: "standalone",    // ブラウザUIを隠す＝“アプリ化”
        background_color: "#ffffff",
        theme_color: "#4f46e5",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" }
        ]
      },

      // （任意）オフライン対応のキャッシュ戦略
      workbox: {
        runtimeCaching: [
          { // ページはネット優先＋オフラインfallback
            urlPattern: ({ request }) => request.mode === "navigate",
            handler: "NetworkFirst",
            options: { cacheName: "pages", networkTimeoutSeconds: 3 }
          },
          { // 静的アセットは高速表示＋裏で更新
            urlPattern: ({ request }) =>
              ["style", "script", "worker"].includes(request.destination),
            handler: "StaleWhileRevalidate",
            options: { cacheName: "assets" }
          },
          { // 画像
            urlPattern: ({ request }) => request.destination === "image",
            handler: "StaleWhileRevalidate",
            options: { cacheName: "images" }
          }
        ]
      }
      // 開発中もSWを動かしたいときだけ：
      // devOptions: { enabled: true }
    })
  ]
});
