// @ts-strict-ignore
import App from './App.vue'
import router from '@/router'
import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { i18n } from './i18n'
import { definePreset } from '@primevue/themes'
import PrimeVue from 'primevue/config'
import Aura from '@primevue/themes/aura'
import ConfirmationService from 'primevue/confirmationservice'
import ToastService from 'primevue/toastservice'
import Tooltip from 'primevue/tooltip'

import { mapSlimComfyNodes, mapSlimExtensions } from './helper/comfyuiNodes'

import '@comfyorg/litegraph/style.css'
import '@/assets/css/style.css'
import 'primeicons/primeicons.css'

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
    primary: Aura['primitive'].blue
  }
})

const app = createApp(App)
const pinia = createPinia()
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
