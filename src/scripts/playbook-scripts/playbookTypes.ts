export interface WorkflowWindowMessageData {
  message:
    | 'RequestWorkflowDataFromComfyWindow'
    | 'SendWorkflowDataToComfyWindow'
    | 'ComfyGraphSetupComplete'
    | 'WrapperOriginSetOnComfyInstance'
    | 'SendWrapperOriginToComfyWindow'
    | 'SendWorkflowDataToPlaybookWrapper'
    | 'SendSelectedNodesToPlaybookWrapper'
    | 'NewWorkflowLoadedInComfyWindow'
    | 'ClearWorkflowInComfyWindow'
    | 'ExportWorkflowJSONFromComfyWindow'
    | 'SendModalAppIDToComfyWindow'
  data?: any
}

/** This type matches one of the same name in Playbook front end repo. */
export type ComfyWorkflowNodeData = {
  id: number
  type: string
  widgets_values: any[]
  widgets: any[]
  title: string
  inputs: {
    link: number
    name: string
    type: string
    slot_index: number
  }[]
  outputs: {
    links: number[]
    name: string
    shape: number
    slot_index: number
    type: string
  }[]
  properties: any
  /** Index 0 is x, index 1 is y. */
  pos: Float32Array
  /** Index 0 is width, index 1 is height. */
  size: Float32Array
  flags: any
}
