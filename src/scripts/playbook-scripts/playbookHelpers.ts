import { Positionable } from "@comfyorg/litegraph";
import { ComfyWorkflowNodeData } from "./playbookTypes";

export function areSelectedItemsEqual(setA: Set<Positionable>, setB: Set<Positionable>) {
    if (setA.size !== setB.size) {
        return false;
    }
    for (const element of setA) {
        if (!setB.has(element)) {
            return false;
        }
    }
    return true;
}

export function restructureSelectedNodesForPlaybookWrapper(selectedNodes: any): ComfyWorkflowNodeData[] {
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
    
    return restructuredNodesData
}
