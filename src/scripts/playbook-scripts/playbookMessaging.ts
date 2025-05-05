import {
  ComfyWorkflowNodeData,
  WorkflowWindowMessageData
} from './playbookTypes'
import fs from 'fs'

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

  window.top.postMessage(messageData, wrapperOrigin)
}

/**
 * Send message with selected nodes data to Playbook wrapper.
 */
export function sendNodeSelectionToPlaybookWrapper(
  selectedNodes: any,
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
    data: JSON.stringify(restructuredNodesData)
  }

  window.top.postMessage(messageData, wrapperOrigin)
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

/**
 * Send node definition data from node_definition.json to wrapping iFrame layer.
 */
export async function sendNodeDefinitionDataToPlaybookWrapper(
  wrapperOrigin: string
) {
  const filePath = '../node_definition.json'

  fs.readFile(filePath, 'utf8', (err, jsonData) => {
    if (err) {
      console.error('Error reading file: ', err)
      return
    }

    try {
      // const data = JSON.parse(jsonString);
      // Now you can use `data` as a normal JavaScript object

      const messageData: WorkflowWindowMessageData = {
        message: 'SendNodeDefinitionDataToPlaybookWrapper',
        data: jsonData
      }

      console.log(
        'Comfy Window Sending: SendWorkflowDataToPlaybookWrapper: ',
        messageData
      )

      window.top.postMessage(messageData, wrapperOrigin)
    } catch (err) {
      console.error('Error parsing JSON: ', err)
    }
  })
}
