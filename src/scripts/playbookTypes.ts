import { ComfyWorkflowJSON } from '@/types/comfyWorkflow'

export interface WorkflowWindowMessageData {
  message:
    | 'RequestWorkflowDataFromComfyWindow'
    | 'SendWorkflowDataToComfyWindow'
    | 'ComfyGraphSetupComplete'
    | 'WrapperOriginSetOnComfyInstance'
    | 'SendWrapperOriginToComfyWindow'
    | 'ComfyWindowInitialized'
    | 'SendWorkflowDataToPlaybookWrapper'
  data?: ComfyWorkflowJSON
}
