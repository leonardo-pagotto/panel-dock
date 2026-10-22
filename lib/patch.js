// SPDX-License-Identifier: GPL-2.0-or-later

export class PatchSet {
    constructor() {
        this._patches = [];
    }

    add(object, methodName, replacement) {
        const already = this._patches.some(patch =>
            patch.object === object && patch.methodName === methodName);

        if (already)
            throw new Error(`Already patched ${methodName}`);

        const original = object[methodName];
        if (original == null)
            throw new Error(`No method ${methodName} to patch`);

        object[methodName] = replacement;
        this._patches.push({object, methodName, original});
        return original;
    }

    restoreAll() {
        while (this._patches.length > 0) {
            const {object, methodName, original} = this._patches.pop();
            object[methodName] = original;
        }
    }
}
