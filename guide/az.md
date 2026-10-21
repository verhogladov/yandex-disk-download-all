# Yandex Diskdən hər şeyi necə endirmək olar

Sadə təlimat. Təxminən beş dəqiqə çəkir.

*Rus dilindən tərcümə olunub — düzəlişləri [GitHub](https://github.com/verhogladov/yandex-disk-download-all/issues) vasitəsilə göndərsəniz, şad olarıq.*

**Nə baş verib.** 11 oktyabr 2026-cı ildən Yandex Disk saytında qovluğu, bir neçə faylı və ya bütün Diski birdən endirmək olmur — yalnız bir-bir. Pulsuz brauzer genişlənməsi «Yandex Diskdən hər şeyi endir» «Endir» düyməsini geri qaytarır: o, faylları bir-bir özü endirir və Diskdəki kimi qovluqlara yerləşdirir.

**Nə lazımdır:**

- kompüter və ya noutbuk (Windows, macOS və ya Linux);
- Google Chrome və ya Yandex Brauzer (Edge, Opera, Brave, Vivaldi də olar);
- kompüterdə boş yer — təxminən Diskdə nə qədər tutulubsa, o qədər.

Telefonda işləmir: mobil brauzerlərə belə genişlənmə quraşdırılmır. Kompüter lazımdır.

## Addım 1. Genişlənməni endirin

1. Klikləyin: **[yandex-disk-download-all.zip endir](https://github.com/verhogladov/yandex-disk-download-all/releases/latest/download/yandex-disk-download-all.zip)**. Fayl «Endirmələr» qovluğunda saxlanacaq.
2. Onu arxivdən çıxarın:
   - **Windows:** fayla siçanın sağ düyməsi ilə basın → «Hamısını çıxar…» («Извлечь все…») → «Çıxar»;
   - **macOS:** fayla iki dəfə klikləyin.
3. `yandex-disk-download-all` qovluğu yaranacaq. Onu mane olmayacağı yerə, məsələn «Sənədlər» qovluğuna köçürün. Sonra silməyin: brauzer genişlənməni bu qovluqdan götürür.

## Addım 2. Genişlənməni brauzerə quraşdırın

**Google Chrome**

1. Ünvan sətrinə `chrome://extensions` yazın və Enter basın.
2. Yuxarı sağ küncdə **«Tərtibatçı rejimi»** (ingiliscə Developer mode, rusca «Режим разработчика») açarını yandırın.
3. Yuxarı sol küncdəki birinci düyməni basın — **«Paketlənməmiş genişlənməni yüklə»** (ingiliscə Load unpacked, rusca «Загрузить распакованное расширение»).
4. `yandex-disk-download-all` qovluğunu seçin (içində `manifest.json` faylı olan qovluq).
5. Siyahıda «Yandex Diskdən hər şeyi endir» görünəcək. Hazırdır.

**Yandex Brauzer** — eynilə, sadəcə ünvan `browser://extensions`.

**Edge, Opera, Brave, Vivaldi** — ünvanlar `edge://extensions`, `opera://extensions`, `brave://extensions`, `vivaldi://extensions`, sonra eynilə: «Tərtibatçı rejimi» → «Paketlənməmiş genişlənməni yüklə».

> «Tərtibatçı rejimi» normaldır: mağazadan olmayan genişlənmələr belə quraşdırılır. Genişlənmə pulsuzdur, kodu açıqdır. Brauzer işə düşəndə belə genişlənmələri söndürməyi təklif etsə — imtina edin.

## Addım 3. «Hara saxlamaq» sualını söndürün

Əks halda brauzer hər fayl barədə soruşacaq, onlar isə minlərlə ola bilər.

- **Chrome:** `chrome://settings/downloads` açın və **«Endirmədən əvvəl hər faylı hara saxlamağı soruş»** seçimini söndürün (ingiliscə Ask where to save each file before downloading, rusca «Перед скачиванием спрашивать, куда сохранить файл»).
- **Yandex Brauzer:** «Настройки» → «Инструменты» → «Загруженные файлы» → **«Всегда спрашивать, куда сохранять файлы»** işarəsini götürün.
- **Digər brauzerlər:** parametrlərin endirmələr bölməsində hər faylın harada saxlanacağı barədə sualı söndürün.

## Addım 4. Faylları endirin

1. [disk.yandex.ru](https://disk.yandex.ru) açın və hesabınıza daxil olun. Disk artıq açıq idisə — səhifəni yeniləyin (F5).
2. Aşağı sağ küncdə mavi **«Bütün Diski endirmək»** düyməsi görünəcək. Qovluğun içində o «Qovluğu endirmək» adlanır, faylları seçsəniz — «Seçilənləri endirmək».
3. Onu basın. Pəncərə açılacaq:
   - **«Nəyi endirmək»** — bütün Disk, bu qovluq, seçilənlər və ya siyahıdan «Faylları və qovluqları seçmək…»;
   - **«Hansı fayllar»** — hamısı və ya «Yalnız lazımi növlər» (məsələn, yalnız foto və video);
   - **«Hara saxlamaq»** — kompüterə Diskdəki kimi fayllar şəklində, bir ZIP arxivi şəklində və ya başqa buluda.
4. **«Endirməyə başlamaq»** düyməsini basın və gözləyin. Pəncərədə nə qədərinin endirildiyi görünür.

![Genişlənmənin pəncərəsi](../docs/guide-window.png)

*Şəkildə rus dilində interfeys var. Dil pəncərənin yuxarı sətrində seçilir: 23 dil var, Azərbaycan dili də.*

**Endirmə gedərkən** Disk vərəqini kiçiltmək olar, amma onu **bağlamayın**. Vərəq bağlansa və ya kompüter sönsə — Diski yenidən açın və «Davam etmək» basın. Artıq endirilmiş fayllar təkrar endirilmir.

**Fayllar haradadır:** «Endirmələr» → «Yandex Disk», Diskdəki kimi qovluqlar üzrə.

## Nəsə alınmasa

| Nə görünür | Nə etməli |
| --- | --- |
| Mavi düymə yoxdur | Disk səhifəsini yeniləyin (F5). `chrome://extensions` daxilində genişlənmənin aktiv olduğunu yoxlayın. |
| Brauzer hər faylı hara saxlamağı soruşur | 3-cü addımı yerinə yetirin və «Davam etmək» basın. |
| Bəzi fayllar «Alınmadı» | Yandex serverləri hazırda hər şeyi vermir. Bir-iki saatdan sonra «Alınmayanları təkrarlamaq» basın. Belə faylların siyahısını «Hesabat (CSV)» düyməsi saxlayır. |
| Kompüterdə yer azdır | Hissələrə bölünmüş «ZIP arxivi», buluda köçürmə seçin və ya brauzer parametrlərində xarici diski endirmələr qovluğu kimi təyin edin. |
| «Yandex yoxlamadan keçməyi xahiş edir» | «Yoxlamadan keçmək» basın, robot olmadığınızı təsdiqləyin, sonra «Davam etmək» basın. |
| Fotonun adında «(önizləmə)» var | Orijinal verilmədi, kiçildilmiş nüsxəsi saxlandı. Sonra «Önizləmə əvəzinə orijinalları yenidən sınamaq» basın. |

## Bu təhlükəsizdirmi?

- Genişlənmə yalnız Yandex Disk saytında və yalnız sizin brauzerinizdə işləyir. Yandex parolunu soruşmur. Fayllarınız heç yerə göndərilmir — özünüzün qoşduğunuz buluddan başqa.
- Bu, Yandex proqramı deyil, kodu açıq olan müstəqil pulsuz layihədir.

## Necə silmək və ya yeniləmək olar

- **Silmək:** `chrome://extensions` → genişlənmənin yanında «Sil». Endirilmiş fayllar qalır.
- **Yeniləmək:** arxivi yenidən endirin (addım 1), köhnə qovluğun üzərinə faylları əvəz etməklə çıxarın, sonra `chrome://extensions` daxilində genişlənmənin yanındakı dairəvi oxu basın.

## Kömək lazımdır?

[Layihənin suallar səhifəsində](https://github.com/verhogladov/yandex-disk-download-all/issues) yazın (pulsuz GitHub hesabı lazımdır). Nə etdiyinizi və nə gördüyünüzü danışın; ekran şəkli çox kömək edər.
