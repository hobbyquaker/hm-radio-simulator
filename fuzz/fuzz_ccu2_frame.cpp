// libFuzzer harness for rfd's side of the radio module's serial line: the frame reassembly (CCU2SerialFrame: 0xFD,
// length, escapes, CRC) fed in chunks the input chooses, and every complete frame parsed as a coprocessor command
// (CCU2CoprocessorCommand: responses, events with flags/RSSI/telegram, duty-cycle and identify events) - the bytes a
// module, or anything on /dev/mmd_bidcos or a LAN gateway's port 2000, can send to rfd.
#include <cstddef>
#include <cstdint>
#include <string>

#include "CCU2SerialFrame.h"
#include "CCU2CoprocessorCommand.h"

using namespace HM2;

static void inspect(const std::string& payload) {
    CCU2CoprocessorCommand cmd(payload);
    volatile bool v = cmd.isResponseValid();
    v = cmd.isEvent();
    v = cmd.isResponseStatusOk();
    v = cmd.isRSSISet();
    v = cmd.isDevWokenUp();
    v = cmd.isDutyCycleEvent();
    v = cmd.isIdentifyEvent();
    v = cmd.isResponseStatusBusy();
    v = cmd.hasAuthentificationStatus();
    (void)v;
    volatile int n = cmd.getRSSI();
    n = cmd.getBidcosTelegramDestinationAddress();
    n = cmd.getBidcosTelegramSourceAddress();
    n = cmd.getBidcosTelegramCounter();
    n = cmd.getAuthenticationKeyIndex();
    n = (int)cmd.getAuthentificationStatus();
    n = (int)cmd.getBidcosCommandResponseStatus();
    (void)n;
    volatile double d = cmd.isDutyCycleEvent() ? cmd.getDutyCycleValue() : 0.0;
    (void)d;
    std::string s = cmd.getCommandData() + cmd.getBidcosCommandResponseStatusAsString();
    (void)s;
}

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size < 1) {
        return 0;
    }
    // the first byte: the chunk size the serial line delivers (1..64), the rest: the bytes
    const size_t chunk = (data[0] & 0x3f) + 1;
    std::string rest(reinterpret_cast<const char*>(data + 1), size - 1);
    CCU2SerialFrame frame;
    std::string pending;
    for (size_t pos = 0; pos < rest.size(); pos += chunk) {
        pending += rest.substr(pos, chunk);
        for (int guard = 0; guard < 64 && !pending.empty(); guard++) {
            std::string leftOver;
            const bool complete = frame.addFrameData(pending, leftOver);
            if (complete) {
                inspect(frame.getPayload());
                frame.reset();
            }
            if (leftOver.size() >= pending.size() && !complete) {
                break;  // nothing consumed
            }
            pending = leftOver;
            if (!complete) {
                break;
            }
        }
    }
    // the payload on its own, as if a frame had carried it
    inspect(rest);
    return 0;
}
