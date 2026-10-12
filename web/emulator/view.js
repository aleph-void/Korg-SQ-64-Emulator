import {createApp} from 'vue';
import App from './EmulatorApp.vue';

createApp(App).mount('#app');

// The site-wide service worker lives one level up; registering it from both
// pages makes either one installable on its own.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('../sw.js').catch(error => console.warn('Service worker unavailable:', error));
}
