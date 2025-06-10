import {
  ComfyWorkflowNodeData,
  WorkflowWindowMessageData
} from './playbookTypes'

/**
 * Send message with workflow data to wrapping iFrame layer.
 */
export function notifyWrapperOriginSetOnComfyInstance(wrapperOrigin: string) {
  console.log(
    'Comfy Window Sending: WrapperOriginSetOnComfyInstance: target origin: ',
    wrapperOrigin
  )

  const messageData: WorkflowWindowMessageData = {
    message: 'WrapperOriginSetOnComfyInstance'
  }

  if (window.top) {
    window.top.postMessage(messageData, wrapperOrigin)
  }
}

export function notifyPlaybookWrapperNewWorkflowLoaded(wrapperOrigin: string) {
  const messageData: WorkflowWindowMessageData = {
    message: 'NewWorkflowLoadedInComfyWindow'
  }

  console.log(
    'Comfy Window Sending: NewWorkflowLoadedInComfyWindow: ',
    messageData
  )

  if (window.top) {
    window.top.postMessage(messageData, wrapperOrigin)
  }
}

/**
 * Send message with selected nodes data to Playbook wrapper.
 */
export function sendNodeSelectionToPlaybookWrapper(
  selectedNodes: ComfyWorkflowNodeData[],
  wrapperOrigin: string
) {
  console.log(
    'Comfy Window Sending: sendNodeSelectionToPlaybookWrapper: target origin: ',
    selectedNodes
  )

  const selectedNodesArray = Object.values(selectedNodes)

  // Reduce node data to structure expected by Playbook wrapper.
  const restructuredNodesData = selectedNodesArray.map((node: any) => {
    const nodeData: ComfyWorkflowNodeData = {
      id: node.id,
      type: node.type,
      widgets_values: node.widgets_values,
      widgets: node.widgets,
      title: node.title,
      inputs: node.inputs,
      outputs: node.outputs,
      properties: node.properties,
      pos: node.pos,
      size: node.size,
      flags: node.flags
    }

    return nodeData
  })

  // Serializing data to prevent errors messaging objects with callbacks.
  const messageData: WorkflowWindowMessageData = {
    message: 'SendSelectedNodesToPlaybookWrapper',
    data: JSON.stringify(selectedNodes)
  }


  if (window.top) {
    window.top.postMessage(messageData, wrapperOrigin)
  }
}

/**
 * Send message with workflow data to wrapping iFrame layer.
 */
export async function sendWorkflowDataToPlaybookWrapper(wrapperOrigin: string) {
  const graphData = await window.__COMFYAPP.graphToPrompt()
  const messageData: WorkflowWindowMessageData = {
    message: 'SendWorkflowDataToPlaybookWrapper',
    data: graphData
  }

  console.log(
    'Comfy Window Sending: SendWorkflowDataToPlaybookWrapper: ',
    messageData
  )

  window.top.postMessage(messageData, wrapperOrigin)
}
