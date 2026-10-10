/**
 * The command set of the BidCoS radio module as rfd speaks it. The first payload byte selects the destination
 * (system or BidCoS), the second is a sequence counter the response repeats, the third the command; the rest is
 * the command's data.
 *
 * The values are the module protocol's public ones: FHEM's HMUARTLGW module and Homegear's Hm-Mod-Rpi-Pcb interface
 * list the same numbers, and OpenCCU-Base's rfd defines them in its coprocessor command header.
 */

export const TYPE = Object.freeze({
    SYSTEM: 0x00,
    BIDCOS: 0x01,
});

export const SYSTEM = Object.freeze({
    IDENTIFY: 0x00,
    GETVERSION: 0x02,
    STARTBOOTLOADER: 0x03,
    RESPONSE_STATUS: 0x04, // only from the module
    EVENT_DUTYCYCLE: 0x05, // only from the module
    SET_10K_DATARATE: 0x06,
    SET_100K_DATARATE: 0x07,
    GETDUTYCYCLE: 0x08,
    DUTYCYCLE_ON_OFF: 0x09,
    CSMACA_ON_OFF: 0x0a,
    GET_SERIALNR: 0x0b,
    SET_CLOCK: 0x0e,
});

export const SYSTEM_STATUS = Object.freeze({
    ERROR: 0x00,
    OK: 0x01,
    DATA: 0x02,
    BUSY: 0x03,
    INPUT_ERROR: 0x04,
});

export const BIDCOS = Object.freeze({
    SET_RF_ADDRESS: 0x00,
    GET_RF_ADDRESS: 0x01,
    SEND_TELEGRAM: 0x02,
    SET_CURRENT_AES_KEY: 0x03,
    STATUS: 0x04, // only from the module
    EVENT: 0x05, // only from the module
    ADD_LINK_PEER: 0x06,
    REMOVE_LINK_PEER: 0x07,
    GET_LINK_PEERS: 0x08,
    AUTHENTICATION_ON: 0x09,
    AUTHENTICATION_OFF: 0x0a,
    SET_TEMP_AES_KEY: 0x0b,
    SET_PEER_KEY_INDEX: 0x0c,
    GET_PEER_KEY_INDEX: 0x0d,
    GET_KEY_CHECKSUM: 0x0e,
    SET_PREVIOUS_KEY: 0x0f,
    GET_DEFAULT_RF_ADDRESS: 0x10,
});

export const BIDCOS_STATUS = Object.freeze({
    ERROR: 0x00,
    OK: 0x01,
    TELEGRAM_SENT: 0x02,
    TELEGRAM_SENT_RECVD_ACK: 0x03,
    SEND_FAILED: 0x04,
    SEND_FAILED_DUTYCYCLE: 0x05,
    SEND_FAILED_CSMACA: 0x06,
    DATA: 0x07,
    BUSY: 0x08,
    TRX_BUSY: 0x09,
    NOT_INITIALIZED: 0x0a,
    INPUT_WRONG: 0x0b,
    AUTHENTICATION_SUCCESS: 0x0c,
    AUTHENTICATION_FAILURE: 0x0d,
});

/** The authentication status in the low three bits of an event's flag byte. */
export const EVENT_AUTH = Object.freeze({
    NOT_RESPONSIBLE: 0x00,
    NO_AUTH_REQUIRED: 0x01,
    AUTH_SUCCESSFUL: 0x02,
    AUTH_FAILED: 0x03,
    KEY_INDEX_UNKNOWN: 0x04,
});

/** Bit 4 of an event's flag byte: the device was woken up (burst). */
export const EVENT_FLAG_WOKEN_UP = 0x10;

export const IDENTIFY_APP = 'Co_CPU_App';
export const IDENTIFY_BOOTLOADER = 'Co_CPU_BL';

function invert(table) {
    const names = new Map();
    for (const [name, value] of Object.entries(table)) {
        names.set(value, name);
    }
    return names;
}

const SYSTEM_NAMES = invert(SYSTEM);
const BIDCOS_NAMES = invert(BIDCOS);
const SYSTEM_STATUS_NAMES = invert(SYSTEM_STATUS);
const BIDCOS_STATUS_NAMES = invert(BIDCOS_STATUS);

/**
 * @param {number} type TYPE.SYSTEM or TYPE.BIDCOS
 * @param {number} command
 * @returns {string} the command's name, or UNKNOWN_xx
 */
export function commandName(type, command) {
    const table = type === TYPE.SYSTEM ? SYSTEM_NAMES : type === TYPE.BIDCOS ? BIDCOS_NAMES : null;
    const name = table && table.get(command);
    return name || `UNKNOWN_${command.toString(16).padStart(2, '0')}`;
}

/**
 * @param {number} type
 * @param {number} status
 * @returns {string}
 */
export function statusName(type, status) {
    const table = type === TYPE.SYSTEM ? SYSTEM_STATUS_NAMES : BIDCOS_STATUS_NAMES;
    return table.get(status) || `UNKNOWN_${status.toString(16).padStart(2, '0')}`;
}

/**
 * Looks a command up by name in either table.
 * @param {string} name e.g. 'GET_SERIALNR' or 'SEND_TELEGRAM'
 * @returns {{type: number, command: number}}
 */
export function commandByName(name) {
    if (name in SYSTEM) {
        return {type: TYPE.SYSTEM, command: SYSTEM[name]};
    }
    if (name in BIDCOS) {
        return {type: TYPE.BIDCOS, command: BIDCOS[name]};
    }
    throw new Error(`unknown command name ${name}`);
}
