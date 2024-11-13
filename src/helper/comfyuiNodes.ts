import { ComfyNode } from '@/types/comfyWorkflow'

export const mapSlimExtensions = function (extensions) {
  return extensions.map(({ name }) => ({ name }))
}

export const slimComfyNodes = function (node: ComfyNode) {
  const {
    id,
    outputs,
    inputs,
    connsections,
    mode,
    order,
    properties,
    porperties_info,
    title,
    type,
    widgets_values,
    widgets
  } = node
  return {
    id,
    outputs,
    inputs,
    connsections,
    mode,
    order,
    properties,
    porperties_info,
    title,
    type,
    widgets_values,
    widgets
  }
}

export const mapSlimComfyNodes = function (nodes: ComfyNode[]) {
  return nodes.map((e) => slimComfyNodes(e))
}
