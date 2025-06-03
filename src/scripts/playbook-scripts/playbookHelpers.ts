import { Positionable } from "@comfyorg/litegraph";

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
