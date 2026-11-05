# Değişiklikler

## 0.3.1 — 5 Kasım 2026

- Yönetici yetkisi gerektirmeyen kullanıcı kurulumu, uygulama menüsü simgesi ve `yansi` başlatma komutu.
- Kullanıcı ayarları ve indirilen dosyaları koruyan kaldırma betiği.
- Public GitHub deposu için İngilizce README, MIT lisansı ve depo bilgileri.

## 0.3.0 — 5 Kasım 2026

- TV ve hareketli görüntü için varsayılan Akıcı mod: `motion` içerik ipucu ve kare hızını korumaya öncelik veren WebRTC ayarı; gerektiğinde çözünürlük uyarlanır. Metin netliğini koruyan ayrı masaüstü modu.
- Kalite ve mod değişiminde görüntü/ses bağlantısını yeniden kurma kaldırıldı. PC önizlemesi isteğe bağlı ve varsayılan kapalı.
- Gerçek gönderim/alım kare hızı, çözünürlük, bitrate, RTT ve kodlama/çözme süresi gösterimi; izleyici ölçümleri yalnız onaylı oturumda iletilir.
- Yerel codec desteği varsa H.264 tercih seçeneği; diğer codec'ler yedek olarak korunur.
- Sayaç farkları ve alıcı ölçümlerinin yaşam döngüsü için testler; masaüstü testinde hareketli görüntü, ses ve bağlantı korunumu kontrolü.
- Gerçek Mi Box ve iki Wi-Fi cihazıyla sürdürülebilir performans kullanıcı cihazında ölçülmelidir; 30 fps bir hedeftir.

## 0.2.0 — 5 Kasım 2026

- Fedora sistem sesi görüntüyle aynı WebRTC bağlantısına eklendi; varsayılan ses çıkışının monitor kaynağı kullanılır, mikrofon yakalanmaz.
- Masaüstünde sistem sesini aktarma seçeneği; TV tarayıcısında kullanıcı etkileşimiyle sesi açma/kapatma.
- Kalite değişiminde ses tercihi korunur; yayın, kilit, uyku veya pencere kapanışında ses yakalama durur.
- 48 kHz stereo PCM için AudioWorklet hattı, sınırlı tampon ve IPC geri basıncı.
- Ses başlatma/iptal ve tampon davranışları için birim testleri; WebRTC alıcısında sıfırdan büyük ses enerjisi doğrulaması.
- Gerçek Fedora monitor kaynağından kısa veri akışı kontrol edildi; ses kaydı saklanmadı. Gerçek Mi Box hoparlör testi kullanıcı cihazında yapılacak.

## 0.1.0 — 5 Kasım 2026

- Türkçe Fedora masaüstü arayüzü: ekran, dosyalar ve cihazlar.
- KDE/Wayland sistem ekran/pencere seçicisiyle yakalama entegrasyonu.
- Mi Box/telefon/PC tarayıcısından IP adresiyle izleme; kumanda yön tuşları, tam ekran ve görüntüyü sığdırma.
- Her izleyici için masaüstünden onay; tek onaylı cihaz ve oturumluk erişim anahtarı.
- 720p/1080p hedefleri, metin netliğini önceleyen WebRTC gönderim ayarları ve kalite değişiminde yeniden bağlantı.
- Paylaşılan dosyaları akış halinde indirme; 1 GiB sınırıyla PC'ye dosya gönderme, ilerleme ve iptal.
- PC kilidi/uyku olaylarında yayını durdurma; eski bağlantı mesajlarının sonraki oturumu bozmaması.
- Electron çalışma zamanı içeren taşınabilir Linux x64 paketi.

Doğrulama: 5 sunucu entegrasyon testi geçti. Masaüstü ve tarayıcı testinde özel üretilmiş 1280×720 görüntü gerçek WebRTC hattında oynatıldı; kalite değişimi, arayüzden dosya indirme/yükleme, kilit olayıyla durdurma ve bağlantıyı kesme geçti.

Gerçek Mi Box tarayıcısı ve KDE/PipeWire ekran yakalama kullanıcının cihazında ayrıca denenmelidir. Sistem sesi, mikrofon, HTTPS, kalıcı cihaz eşleşmesi ve RPM kurulumu bu prototipte yer almıyor. Yerel HTTP sürümü güvenilen deneme ağı içindir.
