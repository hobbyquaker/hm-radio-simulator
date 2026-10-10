// libFuzzer harness for libXmlRpc's request dispatcher: a server connection is handed the fuzzed bytes as a complete
// request body (first input byte selects BIN-RPC or XML-RPC) and executes it against a server with introspection
// (system.listMethods, system.methodHelp, system.multicall - OpenCCU-Base #138 lives in the multicall) and one
// echo method. The connection's socket is a socketpair end nobody reads; the response is only generated, never sent.
#include <cstddef>
#include <cstdint>
#include <string>
#include <sys/socket.h>
#include <unistd.h>

#include "XmlRpcServer.h"
#include "XmlRpcServerConnection.h"
#include "XmlRpcServerMethod.h"
#include "XmlRpcValue.h"

namespace {

class Echo : public XmlRpc::XmlRpcServerMethod {
public:
    explicit Echo(XmlRpc::XmlRpcServer* server) : XmlRpc::XmlRpcServerMethod("echo", server) {}
    void execute(XmlRpc::XmlRpcValue& params, XmlRpc::XmlRpcValue& result) override { result = params; }
    std::string help() override { return "returns its parameters"; }
};

class FuzzConnection : public XmlRpc::XmlRpcServerConnection {
public:
    FuzzConnection(int fd, XmlRpc::XmlRpcServer* server) : XmlRpc::XmlRpcServerConnection(fd, server, false) {}
    void fuzz(const std::string& request, bool binary) {
        _request = request;
        _isBinary = binary;
        executeRequest();
    }
};

XmlRpc::XmlRpcServer* server = nullptr;
Echo* echo = nullptr;
int fds[2] = {-1, -1};

}  // namespace

extern "C" int LLVMFuzzerInitialize(int*, char***) {
    server = new XmlRpc::XmlRpcServer();
    server->enableIntrospection(true);
    echo = new Echo(server);
    socketpair(AF_UNIX, SOCK_STREAM, 0, fds);
    return 0;
}

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    if (size < 1) {
        return 0;
    }
    const bool binary = (data[0] & 1) != 0;
    std::string request(reinterpret_cast<const char*>(data + 1), size - 1);
    int fd = dup(fds[0]);
    FuzzConnection* connection = new FuzzConnection(fd, server);
    try {
        connection->fuzz(request, binary);
    } catch (...) {
    }
    connection->close();
    delete connection;
    return 0;
}
