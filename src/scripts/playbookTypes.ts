import { ComfyWorkflowJSON } from '@/types/comfyWorkflow'

export interface WorkflowWindowMessageData {
  message:
    | 'RequestWorkflowDataFromComfyWindow'
    | 'SendWorkflowDataToComfyWindow'
    | 'ComfyWindowInitialized'
    | 'SendWrapperOriginToComfyWindow'
    | 'SendWorkflowDataToPlaybookWrapper'
  data?: ComfyWorkflowJSON
}
