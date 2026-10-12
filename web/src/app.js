import {createApp} from 'vue';
import App from './App.vue';

createApp(App).mount('#app');

// The build export generates sw.js; the dev server has no service worker.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js').catch(error => console.warn('Service worker unavailable:', error));
}
