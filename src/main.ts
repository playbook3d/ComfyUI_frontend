import '@comfyorg/litegraph/style.css'
import { definePreset } from '@primevue/themes'
import Aura from '@primevue/themes/aura'
import * as Sentry from '@sentry/vue'
import { createPinia } from 'pinia'
import 'primeicons/primeicons.css'
import PrimeVue from 'primevue/config'
import ConfirmationService from 'primevue/confirmationservice'
import ToastService from 'primevue/toastservice'
import Tooltip from 'primevue/tooltip'
import { createApp } from 'vue'

// import { mapSlimComfyNodes, mapSlimExtensions } from './helper/comfyuiNodes'

import { mapSlimComfyNodes, mapSlimExtensions } from './helper/comfyuiNodes'

import '@comfyorg/litegraph/style.css'
import '@/assets/css/style.css'
import router from '@/router'

import App from './App.vue'
import { i18n } from './i18n'

declare global {
  interface Window {
    __COMFYAPP: any
  }
}

declare global {
  interface Window {
    __WORKSPACEAPP: any
  }
}

/*
 *  listener used for communication between iframe and playbook app
 */

window.addEventListener('message', (event) => {
  const origin = import.meta.env.VITE_CONNECT_TO
  if (event.origin === origin) {
    console.log('HELLO FROM THE PLAYBOOK', event.data, event)

    const { graph, extensions } = window.__WORKSPACEAPP

    const {
      _nodes_by_id: nodes_by_id,
      _nodes: nodes,
      _nodes_in_order: nodes_ordered
    } = graph

    const dataToSend = {
      workflow: {
        //nodes_ordered,
        nodes: mapSlimComfyNodes(nodes)
        //nodes_by_id,
      },
      extensions: mapSlimExtensions(extensions)
    }
    console.log('DATA TO SEND:', dataToSend)

    window.top.postMessage(JSON.parse(JSON.stringify(dataToSend)), origin)
  } else {
    return
  }
})

const ComfyUIPreset = definePreset(Aura, {
  semantic: {
    // @ts-expect-error fixme ts strict error
    primary: Aura['primitive'].blue
  }
})

const app = createApp(App)
const pinia = createPinia()
Sentry.init({
  app,
  dsn: __SENTRY_DSN__,
  enabled: __SENTRY_ENABLED__,
  release: __COMFYUI_FRONTEND_VERSION__,
  integrations: [],
  autoSessionTracking: false,
  defaultIntegrations: false,
  normalizeDepth: 8,
  tracesSampleRate: 0
})
app.directive('tooltip', Tooltip)
app
  .use(router)
  .use(PrimeVue, {
    theme: {
      preset: ComfyUIPreset,
      options: {
        prefix: 'p',
        cssLayer: {
          name: 'primevue',
          order: 'primevue, tailwind-utilities'
        },
        // This is a workaround for the issue with the dark mode selector
        // https://github.com/primefaces/primevue/issues/5515
        darkModeSelector: '.dark-theme, :root:has(.dark-theme)'
      }
    }
  })
  .use(ConfirmationService)
  .use(ToastService)
  .use(pinia)
  .use(i18n)
  .mount('#vue-app')
