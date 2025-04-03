import { ComfyWorkflowJSON } from '@/types/comfyWorkflow'

export interface WorkflowWindowMessageData {
  message:
    | 'RequestWorkflowDataFromComfyWindow'
    | 'SendWorkflowDataToComfyWindow'
    | 'ComfyGraphSetupComplete'
    | 'WrapperOriginSetOnComfyInstance'
    | 'SendWrapperOriginToComfyWindow'
    | 'ComfyWindowInitialized'
    | 'SendWrapperOriginToComfyWindow'
    | 'SendWorkflowDataToPlaybookWrapper'
  data?: ComfyWorkflowJSON
}
