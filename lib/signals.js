// SPDX-License-Identifier: GPL-2.0-or-later

import GObject from 'gi://GObject';

export class SignalTracker {
    constructor() {
        this._connections = [];
    }

    connect(object, signal, callback) {
        const id = object.connect(signal, callback);
        this._connections.push({object, id});
        return id;
    }

    disconnectAll() {
        while (this._connections.length > 0) {
            const {object, id} = this._connections.pop();

            try {
                if (id && GObject.signal_handler_is_connected(object, id))
                    object.disconnect(id);
            } catch (e) {
                // The object may already be gone during session shutdown.
            }
        }
    }
}
