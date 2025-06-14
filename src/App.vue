<template>
  <router-view />
  <ProgressSpinner
    v-if="isLoading"
    class="absolute inset-0 flex justify-center items-center h-[unset]"
  />
  <GlobalDialog />
  <BlockUI full-screen :blocked="isLoading" />
</template>

<script setup lang="ts">
import { useEventListener } from '@vueuse/core'
import BlockUI from 'primevue/blockui'
import ProgressSpinner from 'primevue/progressspinner'
import { computed, onMounted } from 'vue'

import GlobalDialog from '@/components/dialog/GlobalDialog.vue'
import config from '@/config'
import { useWorkspaceStore } from '@/stores/workspaceStore'

import { AccountsApi } from './scripts/accountsApi'
import { electronAPI, isElectron } from './utils/envUtil'

const workspaceStore = useWorkspaceStore()
const isLoading = computed<boolean>(() => workspaceStore.spinner)
const handleKey = (e: KeyboardEvent) => {
  workspaceStore.shiftDown = e.shiftKey
}
useEventListener(window, 'keydown', handleKey)
useEventListener(window, 'keyup', handleKey)

const showContextMenu = (event: MouseEvent) => {
  const { target } = event
  switch (true) {
    case target instanceof HTMLTextAreaElement:
    case target instanceof HTMLInputElement && target.type === 'text':
      // TODO: Context input menu explicitly for text input
      electronAPI()?.showContextMenu({ type: 'text' })
      return
  }
}

onMounted(async () => {
  console.log(import.meta.env.VITE_API_KEY)
  const accountApi = new AccountsApi(
    import.meta.env.VITE_MODAL_API,
    import.meta.env.VITE_API_KEY
  )
  // Get value by queryString
  const urlParams = new URLSearchParams(window.location.search)
  let teamId
  if (urlParams.has('team_id')) {
    window['team_id'] = urlParams.get('team_id')
    teamId = urlParams.get('team_id')
  }
  const { app_url, user_jwt, workflow_id } = await (
    await accountApi.getInfo(teamId as string)
  ).json()

  console.log({ app_url, user_jwt, workflow_id })

  // @ts-expect-error fixme ts strict error
  window['__COMFYUI_FRONTEND_VERSION__'] = config.app_version
  console.log('ComfyUI Front-end version:', config.app_version)
  window['app_url'] = app_url
  window['user_jwt'] = user_jwt
  window['workflow_id'] = workflow_id
  if (isElectron()) {
    document.addEventListener('contextmenu', showContextMenu)
  }
})
</script>
