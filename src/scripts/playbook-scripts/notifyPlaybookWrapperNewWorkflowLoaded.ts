import { WorkflowWindowMessageData } from './playbookTypes'

export function notifyPlaybookWrapperNewWorkflowLoaded(wrapperOrigin: string) {
  const messageData: WorkflowWindowMessageData = {
    message: 'NewWorkflowLoadedInComfyWindow'
  }

  console.log(
    'Comfy Window Sending: NewWorkflowLoadedInComfyWindow: ',
    messageData
  )

  window.top.postMessage(messageData, wrapperOrigin)
}
