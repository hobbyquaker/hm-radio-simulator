// libFuzzer harnesses for the text files the daemons read, one binary per format (FORMAT at compile time):
//   0 fuzz_propertymap: PropertyMap (rfd.conf, hs485d.conf, the keys and ids files) - read, list, write, read back
//   1 fuzz_hexfile:     Hexfile (hs485d's wired firmware .hex files, read at start-up for their versions)
//   2 fuzz_updatefile:  UpdateFile (rfd's firmware update files)
// The daemons read them from files, so the input is written to a temporary file first.
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <string>
#include <unistd.h>

#include "PropertyMap.h"
#include "Hexfile.h"
#include "UpdateFile.h"

#ifndef FORMAT
#define FORMAT 0
#endif

static std::string tempFile(const std::string& content) {
    char name[] = "/tmp/hmrs-fuzz-XXXXXX";
    int fd = mkstemp(name);
    if (fd < 0) {
        return "";
    }
    size_t done = 0;
    while (done < content.size()) {
        ssize_t n = write(fd, content.data() + done, content.size() - done);
        if (n <= 0) {
            break;
        }
        done += (size_t)n;
    }
    close(fd);
    return name;
}

extern "C" int LLVMFuzzerTestOneInput(const uint8_t* data, size_t size) {
    const int kind = FORMAT;
    std::string content(reinterpret_cast<const char*>(data), size);
    std::string file = tempFile(content);
    if (file.empty()) {
        return 0;
    }
    if (kind == 0) {
        PropertyMap map;
        map.ReadFromFile(file);
        PropertyMap::StringList sections = map.ListSections();
        for (size_t i = 0; i < sections.size() && i < 16; i++) {
            PropertyMap::Section section = map.GetSection(sections[i]);
            for (PropertyMap::Section::iterator it = section.begin(); it != section.end(); ++it) {
                map.SetCurrentSection(sections[i]);
                (void)map.GetIntValue(it->first);
                (void)map.GetFloatValue(it->first);
                (void)map.GetBinaryValue(it->first);
            }
        }
        std::string out = file + ".out";
        map.WriteToFile(out);
        PropertyMap back;
        back.ReadFromFile(out);
        unlink(out.c_str());
    } else if (kind == 1) {
        Hexfile hex;
        hex.Read(file);
        (void)hex.GetStart();
        (void)hex.GetBuffer().size();
    } else {
        UpdateFile update;
        update.Read(file, 0);
        for (int i = 0; i < update.getUpdateFrameCount() && i < 64; i++) {
            (void)update.getFrameLength(i);
            (void)update.getUpdateFrame(i).size();
        }
    }
    unlink(file.c_str());
    return 0;
}
