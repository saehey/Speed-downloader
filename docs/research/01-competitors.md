# ขั้นที่ 1: ศึกษาคู่แข่ง

ค้นเมื่อ 9 พฤศจิกายน 2026 ดูการเปลี่ยนแปลงย้อนหลังประมาณ 12 เดือน จาก release notes ทางการ, GitHub และหน้าเว็บของแต่ละโปรแกรม ศึกษาจากเอกสารเท่านั้น ไม่ได้ติดตั้งหรือแกะโปรแกรมของใคร

## ใครยังพัฒนาอยู่

| โปรแกรม | สถานะล่าสุด | เทคโนโลยี | หมายเหตุ |
|---|---|---|---|
| **Motrix** | 2.0.0 เมื่อ 23 ต.ค. 2026 และออก 2.4.0 เมื่อ 8 พ.ย. 2026 | Electron 45, React, TypeScript, aria2 | **คู่แข่งตรงที่สุด** เพราะใช้ stack เดียวกับเรา และเพิ่งเขียนใหม่ทั้งหมด |
| **Gopeed** | 2.0.0-beta.4 เมื่อ 3 พ.ย. 2026 | Go, Flutter | รองรับเกือบทุกแพลตฟอร์ม รวม iOS, Android และ NAS |
| **AB Download Manager** | 1.11.4 เมื่อ 3 พ.ย. 2026 | Kotlin, Compose Multiplatform | ออกเวอร์ชันใหม่ทุก 2 ถึง 4 สัปดาห์ |
| **XDM** | 9.0.9 เมื่อ 1 พ.ย. 2026 | เขียนใหม่ทั้งหมด | README บอกว่ากำลังสร้างใหม่ในปี 2026 |
| **IDM** | 6.43 Build 18 เมื่อ 4 พ.ย. 2026 | เจ้าของปิดซอร์ส | อัปเดตเกือบทั้งปีเป็นการแก้การโหลดวิดีโอและ error 403 |
| **Free Download Manager** | 6.34 ถึง 6.35 ในปี 2026 | ปิดซอร์ส | หาบันทึกฟีเจอร์ของปี 2026 ไม่เจอ ในฟอรัมมีคนบ่นเรื่อง UI ใหม่ |
| **JDownloader 2** | 2.1 กลางปี 2026 | Java | หาบันทึกฟีเจอร์ที่ระบุวันที่ไม่เจอ |
| Persepolis | 5.2.0 เมื่อ ก.ค. 2025 | Python | ช้าลงชัดเจน จึงไม่นับเป็นคู่แข่งหลัก |
| Neat Download Manager | ไม่พบประกาศทางการในปี 2026 | ปิดซอร์ส | มีแต่เว็บรวมโปรแกรมที่ข้อมูลขัดกันเอง จึงไม่นับ |

## สิ่งที่คู่แข่งเพิ่มในรอบปี

จัดกลุ่มจากบันทึกการเปลี่ยนแปลง ช่อง "เรา" คือสถานะของ Speed Downloader 1.6.2 ที่ตรวจจากโค้ด

| แนวโน้ม | ใครทำแล้ว | เรา |
|---|---|---|
| **ใส่เครื่องหมาย "มาจากอินเทอร์เน็ต" ให้ไฟล์ที่โหลดเสร็จ** (Mark of the Web) เพื่อให้ SmartScreen ยังตรวจไฟล์ได้ | XDM 9 | **มีแล้วตั้งแต่ 1.6.3** ตอนศึกษายังไม่มี (ดูหัวข้อถัดไป) |
| ตรวจ checksum ของไฟล์ที่โหลดเสร็จ | XDM 9, Gopeed 2 beta.4 | ไม่มี |
| ใช้งานผ่าน command line | Motrix 2, AB DM 1.10, Gopeed, XDM 9 | ไม่มี |
| ส่วน server สำหรับ NAS หรือ Docker พร้อม Web UI | Motrix 2 (Docker, Synology, fnOS), Gopeed (Docker, QNAP) | ไม่มี |
| เชื่อม AI agent ผ่าน MCP | Gopeed 2 beta.1 และ beta.4 เพิ่มเครื่องมือดูความเร็วและความคืบหน้า | ไม่มี |
| ระบบ plugin หรือ extension | Motrix 2 (มี sandbox และ marketplace), Gopeed | ไม่มี |
| เบราว์เซอร์เปิดแอปเองได้เมื่อแอปยังไม่ทำงาน | AB DM 1.10, Motrix 2 | **มีแล้ว** (native messaging) |
| ปุ่มหลักในเมนู tray เช่น จำกัดความเร็ว, เริ่มหรือหยุดคิว, เพิ่มลิงก์จากคลิปบอร์ด | AB DM 1.10.2 ถึง 1.11.2 | **มีบางส่วน** มีหยุดทั้งหมดและเพิ่มลิงก์จากคลิปบอร์ด แต่ยังไม่มีปุ่มจำกัดความเร็วใน tray |
| แยกโฟลเดอร์ตามชนิดไฟล์ | Gopeed 2 beta.4, XDM 9 | **มีแล้ว** ตั้งแต่ 1.4.0 |
| ลองใหม่โดยแก้ลิงก์หรือ header ได้ | Motrix 2.1.0 | **มีแล้ว** (ปุ่มใส่ลิงก์ใหม่) |
| เขียนไฟล์ตรงไปที่ไฟล์จริง ไม่ต้องรวมไฟล์ตอนท้าย | XDM 9 | มีแล้วโดยปริยาย เพราะ aria2 เขียนลงไฟล์เดียว |
| หยุดเมื่อดิสก์มีปัญหาโดยเก็บส่วนที่โหลดแล้ว | XDM 9 | มีการแจ้งปัญหาดิสก์ แต่ยังไม่ได้ทดสอบว่าเก็บส่วนที่โหลดแล้วไว้หรือไม่ |
| รวม HLS/DASH เป็น MP4 โดยไม่ต้องใช้ ffmpeg | XDM 9, IDM 6.43 | ไม่มี ถ้าเครื่องไม่มี ffmpeg จะได้คุณภาพต่ำกว่า |
| โหลดทุกไฟล์ที่ตรงเงื่อนไขจากหน้าเว็บในครั้งเดียว | XDM 9 | ไม่มี |
| DNS over HTTPS | AB DM 1.10.2 | ไม่มี |
| FTP | Motrix 2, Gopeed 2 beta.4 | ไม่ได้ทดสอบ แม้ aria2 จะรองรับ |
| Windows บน ARM64 | Motrix 2, Gopeed, XDM 9 | ไม่มี มีแค่ x64 |
| แอปมือถือ | Gopeed, AB DM (Android) | ไม่มี |
| อัปเดตแอปอัตโนมัติ | Motrix 2 | ไม่มี |

## ผลทดสอบ: ไฟล์ที่แอปโหลดไม่มี Mark of the Web

ผมใช้ `aria2c.exe` ตัวเดียวกับที่แอปใช้ โหลดไฟล์ `test.exe` จาก server ในเครื่อง แล้วดู stream ของไฟล์ พบเพียง `:$DATA` ไม่มี `Zone.Identifier` และในโค้ดของแอปก็ไม่มีส่วนที่เขียนเครื่องหมายนี้

**ผลกระทบ:** ไฟล์ที่โหลดผ่านเบราว์เซอร์โดยตรงจะมีเครื่องหมายนี้ ส่วนไฟล์ที่โหลดผ่านแอปเราไม่มี เมื่อผู้ใช้เปิดไฟล์โปรแกรมหรือเอกสาร Office ที่ได้จากแอป Windows จึงอาจข้ามการตรวจของ SmartScreen และไม่เปิด Office ในโหมด Protected View แอปที่รับไฟล์แทนเบราว์เซอร์จึงทำให้ระบบป้องกันนี้หายไป

**ข้อจำกัดของการทดสอบ:** ทดสอบกับ server ในเครื่อง และยังไม่ได้ลองเปิดไฟล์ให้ SmartScreen ทำงานจริง

**แก้แล้วในเวอร์ชัน 1.6.3:** แอปใส่ `Zone.Identifier` ให้ไฟล์ HTTP, ไฟล์ทุกไฟล์ใน torrent และไฟล์วิดีโอทันทีที่โหลดเสร็จ ก่อนที่แถวจะแสดงว่าเสร็จแล้ว ในเครื่องหมายมีเฉพาะเว็บและ path ต้นทาง ไม่มี query, fragment หรือชื่อผู้ใช้และรหัสผ่าน แอปยังทำตาม policy "Do not preserve zone information" ของ Windows ด้วย จากการทดสอบ script PowerShell ที่ติดเครื่องหมายนี้ถูกบล็อกภายใต้ policy RemoteSigned แสดงว่า Windows อ่านเครื่องหมายนี้ได้จริง

## ข้อสังเกต

1. **การแข่งขันด้านฟีเจอร์ย้ายไปอยู่นอกหน้าต่างแอป** เช่น CLI, server บน NAS, MCP สำหรับ AI agent, plugin และมือถือ ส่วนฟีเจอร์พื้นฐานแทบเหมือนกันหมดแล้ว
2. **ความปลอดภัยและความถูกต้องเริ่มเป็นจุดขาย** เช่น Mark of the Web, checksum, การจำกัด integration server ให้รับเฉพาะเครื่องตัวเอง (AB DM 1.10.3) และการบังคับใช้ API key (AB DM 1.11.2)
3. **IDM ใช้เวลาเกือบทั้งปีแก้ปัญหาวิดีโอ** ส่วนใหญ่เป็น error 403 และการรวมไฟล์ TS เป็น MP4 แสดงว่าการโหลดวิดีโอต้องดูแลต่อเนื่อง ไม่ได้ทำครั้งเดียวจบ
4. **Motrix 2 คือตัวเทียบที่ดีที่สุดสำหรับ case study** เพราะใช้ Electron กับ aria2 เหมือนเรา ถ้าวัดหน่วยความจำของ Motrix 2 ในเงื่อนไขเดียวกันได้ จะได้ตัวเลขเทียบที่มีความหมายกว่าการเทียบกับตัวเองอย่างเดียว

## สิ่งที่ยังไม่รู้

- ฟีเจอร์ของ FDM และ JDownloader ในปี 2026 เพราะไม่พบบันทึกการเปลี่ยนแปลงที่ระบุวันที่
- ฟีเจอร์ใหม่ของ XDM 9.0.x แต่ละรุ่น เพราะ release notes ว่างเปล่า จึงใช้ข้อมูลจาก README แทน
- คู่แข่งเหล่านี้ใช้ทรัพยากรเท่าไรจริง ยังไม่ได้วัด

## แหล่งข้อมูล

- [Motrix releases](https://github.com/agalwood/Motrix/releases), [Motrix 2.0.0](https://github.com/agalwood/Motrix/releases/tag/v2.0.0)
- [Gopeed 2.0.0-beta.1](https://github.com/GopeedLab/gopeed/releases/tag/v2.0.0-beta.1), [Gopeed 2.0.0-beta.4](https://github.com/GopeedLab/gopeed/releases/tag/v2.0.0-beta.4)
- [AB Download Manager](https://github.com/amir1376/ab-download-manager) และ [releases](https://github.com/amir1376/ab-download-manager/releases)
- [XDM README](https://github.com/subhra74/xdm)
- [IDM: What's new](https://www.internetdownloadmanager.com/news.html)
- [Free Download Manager](https://www.freedownloadmanager.org/), [ฟอรัม FDM](https://www.freedownloadmanager.org/board/viewforum.php?f=1), [ประวัติเวอร์ชัน FDM (VideoHelp)](https://www.videohelp.com/software/Free-Download-Manager-/version-history)
- [JDownloader changes](https://jdownloader.org/changes/index), [รายการ JDownloader 2.1 (PC-WELT)](https://www.pcwelt.de/?p=1148209)
- [Persepolis releases](https://github.com/persepolisdm/persepolis/releases)
