// libFuzzer harness for hs485d's side of the HMW-LGW link: the transport frame reassembly (HMWLGWTransportFrame:
// 0xFD, length, 0xFC escapes) fed in chunks, and every complete frame parsed as a gateway command (HMWLGWCommand:
// 'r' responses, 'a' answers, 'd'/'c' discovery results, 'e' events), then assembled again - what a wired LAN gateway
// (or anything on its port) sends to hs485d after the preamble.
#include <cstddef>
#include <cstdint>
#include <string>

#include "HMWLGWTransportFrame.h"
#include "HMWLGWCommand.h"

static void inspect(const std::string& payload) {
    HMWLGWCommand cmd;
    if (!cmd.parseFromRawData(payload)) {
        return;
    }
    volatile unsigned int n = cmd.getReceiverAddress();
    n = cmd.getSenderAddress();
    n = cmd.getCtrlByte();
    n = cmd.getTimeout();
    n = (unsigned int)cmd.getCommandType();
    (void)n;
    std::string again = cmd.assembleCmdRawData() + cmd.getCommandData();
    HMWLGWCommand request(again);
    (void)cmd.isResponseOf(request);
    HMWLGWCommand copy(payload);
    (void)copy.transformResponseToEvent(request);
}

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size < 1) {
        return 0;
    }
    const size_t chunk = (data[0] & 0x3f) + 1;
    std::string rest(reinterpret_cast<const char*>(data + 1), size - 1);
    HMWLGWTransportFrame frame;
    std::string pending;
    for (size_t pos = 0; pos < rest.size(); pos += chunk) {
        pending += rest.substr(pos, chunk);
        for (int guard = 0; guard < 64 && !pending.empty(); guard++) {
            std::string leftOver;
            const bool complete = frame.addIncomingFrameData(pending, leftOver);
            if (complete) {
                inspect(frame.getPayload());
                frame = HMWLGWTransportFrame();
            }
            if (!complete || leftOver.size() >= pending.size()) {
                pending = complete ? leftOver : std::string();
                break;
            }
            pending = leftOver;
        }
    }
    inspect(rest);
    return 0;
}
