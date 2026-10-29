import {createPublicDemoTransport} from './pages-adapter.mjs';
window.DATAHUB_TRANSPORT=createPublicDemoTransport();
await import('./app.js');
