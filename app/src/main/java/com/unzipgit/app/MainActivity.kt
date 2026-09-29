package com.unzipgit.app

import android.annotation.SuppressLint
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.DocumentsContract
import android.provider.OpenableColumns
import android.content.Context
import android.net.ConnectivityManager
import android.net.NetworkCapabilities
import android.view.MenuItem
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.ValueCallback
import android.webkit.JsResult
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.ActionBarDrawerToggle
import com.google.android.material.dialog.MaterialAlertDialogBuilder
import androidx.appcompat.app.AppCompatActivity
import androidx.core.view.GravityCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.updatePadding
import androidx.drawerlayout.widget.DrawerLayout
import com.google.android.material.navigation.NavigationView
import com.unzipgit.app.databinding.ActivityMainBinding
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.BufferedInputStream
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.io.File
import java.io.IOException
import java.io.InterruptedIOException
import java.net.HttpURLConnection
import java.net.URL
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.json.JSONArray
import org.json.JSONObject

class MainActivity : AppCompatActivity(), NavigationView.OnNavigationItemSelectedListener {

    private lateinit var binding: ActivityMainBinding
    private companion object {
        const val ASSETS = "https://appassets.androidplatform.net/assets/"
        // При запуске открывается страница со списком репозиториев
        const val HOME_URL = ASSETS + "repos.html"
        const val UNZIP_URL = ASSETS + "index.html"
        const val FILES_URL = ASSETS + "files.html"
        const val TOKENS_URL = ASSETS + "tokens.html"
        const val RELEASES_URL = ASSETS + "releases.html"
    }

    @Volatile
    private var operationRunning = false
    private var filePathCallback: ValueCallback<Array<Uri>>? = null
    private val httpExecutor = Executors.newCachedThreadPool()

    // Файл, ожидающий сохранения после выбора места в системном окне
    @Volatile
    private var pendingSave: ByteArray? = null

    private val saveLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("*/*")
    ) { uri: Uri? ->
        val bytes = pendingSave
        pendingSave = null
        if (uri != null && bytes != null) {
            httpExecutor.execute {
                val ok = try {
                    contentResolver.openOutputStream(uri, "wt")?.use { it.write(bytes) } != null
                } catch (e: Exception) {
                    false
                }
                runOnUiThread {
                    Toast.makeText(
                        this@MainActivity,
                        getString(if (ok) R.string.file_saved else R.string.file_save_error),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }
    }

    // ---- Релизы: файлы читаются и отправляются напрямую с диска, без загрузки в память WebView ----
    private class PickedFile(val uri: Uri, val name: String, val size: Long, val mime: String)
    private class PendingDownload(val id: String, val url: String, val token: String)

    private val pickedFiles = ConcurrentHashMap<String, PickedFile>()
    // id передачи -> признак отмены
    private val transfers = ConcurrentHashMap<String, Boolean>()
    @Volatile
    private var pendingDownload: PendingDownload? = null

    private val pickLauncher = registerForActivityResult(
        ActivityResultContracts.OpenMultipleDocuments()
    ) { uris: List<Uri>? ->
        val arr = JSONArray()
        uris?.forEach { uri ->
            val (name, size) = queryMeta(uri)
            val mime = try { contentResolver.getType(uri) } catch (e: Exception) { null }
            val id = UUID.randomUUID().toString()
            pickedFiles[id] = PickedFile(uri, name, size, mime ?: "application/octet-stream")
            arr.put(JSONObject().apply {
                put("id", id)
                put("name", name)
                put("size", size)
                put("mime", mime ?: "application/octet-stream")
            })
        }
        jsCall("window.__ugPicked", arr.toString())
    }

    private val downloadLauncher = registerForActivityResult(
        ActivityResultContracts.CreateDocument("*/*")
    ) { uri: Uri? ->
        val p = pendingDownload
        pendingDownload = null
        if (p != null) {
            if (uri == null) {
                jsCall("window.__ugDownloadDone", p.id, false, "cancel")
            } else {
                try {
                    httpExecutor.execute { doDownload(p, uri) }
                } catch (e: Exception) {
                    jsCall("window.__ugDownloadDone", p.id, false, e.message ?: "Ошибка")
                }
            }
        }
    }

    private val fileChooserLauncher = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult()
    ) { result ->
        val data = result.data
        val uris = if (result.resultCode == RESULT_OK && data != null) {
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, data)
        } else {
            null
        }
        filePathCallback?.onReceiveValue(uris)
        filePathCallback = null
    }

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        binding = ActivityMainBinding.inflate(layoutInflater)
        setContentView(binding.root)

        setSupportActionBar(binding.toolbar)

        val toggle = ActionBarDrawerToggle(
            this, binding.drawerLayout, binding.toolbar,
            R.string.navigation_drawer_open, R.string.navigation_drawer_close
        )
        binding.drawerLayout.addDrawerListener(toggle)
        toggle.syncState()

        binding.navView.setNavigationItemSelectedListener(this)
        setupDrawerHeaderInsets()
        binding.drawerLayout.addDrawerListener(object : DrawerLayout.SimpleDrawerListener() {
            override fun onDrawerStateChanged(newState: Int) {
                if (newState != DrawerLayout.STATE_IDLE) {
                    applyDrawerHeaderInset()
                    updateHeaderRepo()
                }
            }
        })

        // Нижняя панель: возвращаем false — выделение ставит syncNav() после реальной загрузки страницы
        binding.bottomNav.setOnItemSelectedListener { item ->
            navigateTo(item.itemId)
            false
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                when {
                    binding.drawerLayout.isDrawerOpen(GravityCompat.START) ->
                        binding.drawerLayout.closeDrawer(GravityCompat.START)
                    // Сначала пусть страница сама обработает «Назад»
                    // (закрыть окно/редактор/поиск, подняться на папку выше)
                    else -> binding.webview.evaluateJavascript(
                        "(function(){try{return !!(window.__onBack&&window.__onBack())}catch(e){return false}})()"
                    ) { result ->
                        if (result != "true") goBackOrExit(this)
                    }
                }
            }
        })

        initWebView(savedInstanceState)
    }

    // Боковое меню рисуется на всю высоту экрана, в том числе под статус-баром.
    // Чтобы статус-бар не перекрывал логотип и название, добавляем к шапке верхний отступ
    // на высоту статус-бара (через insets, а если они не пришли — берём из окна напрямую).
    private var headerBasePaddingTop = -1
    private var footerBasePaddingBottom = -1

    private fun setupDrawerHeaderInsets() {
        val header = binding.navView.getHeaderView(0) ?: return
        headerBasePaddingTop = header.paddingTop
        // Нижняя подпись меню не должна уходить под навигационную панель
        footerBasePaddingBottom = binding.drawerFooter.paddingBottom
        ViewCompat.setOnApplyWindowInsetsListener(binding.drawerPanel) { _, insets ->
            setFooterBottomInset(insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
            insets // не поглощаем — NavigationView внутри тоже должен получить отступы
        }
        ViewCompat.setOnApplyWindowInsetsListener(header) { _, insets ->
            setHeaderTopInset(insets.getInsets(WindowInsetsCompat.Type.statusBars()).top)
            insets
        }
        header.post { applyDrawerHeaderInset() }
    }

    private fun applyDrawerHeaderInset() {
        val insets = ViewCompat.getRootWindowInsets(binding.root) ?: return
        setHeaderTopInset(insets.getInsets(WindowInsetsCompat.Type.statusBars()).top)
        setFooterBottomInset(insets.getInsets(WindowInsetsCompat.Type.navigationBars()).bottom)
    }

    private fun setFooterBottomInset(bottom: Int) {
        val footer = binding.drawerFooter
        if (footerBasePaddingBottom < 0) footerBasePaddingBottom = footer.paddingBottom
        val want = footerBasePaddingBottom + bottom
        if (footer.paddingBottom != want) footer.updatePadding(bottom = want)
    }

    private fun setHeaderTopInset(top: Int) {
        val header = binding.navView.getHeaderView(0) ?: return
        if (headerBasePaddingTop < 0) headerBasePaddingTop = header.paddingTop
        val want = headerBasePaddingTop + top
        if (header.paddingTop != want) header.updatePadding(top = want)
    }

    override fun onPause() {
        if (!operationRunning) {
            binding.webview.onPause()
        }
        super.onPause()
    }

    override fun onResume() {
        super.onResume()
        binding.webview.onResume()
    }

    override fun onDestroy() {
        cancelAllTransfers()
        filePathCallback?.onReceiveValue(null)
        filePathCallback = null
        binding.webview.removeJavascriptInterface("AndroidInterface")
        try { httpExecutor.shutdownNow() } catch (_: Exception) { }
        try {
            (binding.webview.parent as? ViewGroup)?.removeView(binding.webview)
            binding.webview.destroy()
        } catch (_: Exception) { }
        super.onDestroy()
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        binding.webview.saveState(outState)
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun initWebView(savedState: Bundle?) {
        val webView = binding.webview
        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            setSupportZoom(true)
            builtInZoomControls = true
            displayZoomControls = false
            // Страницы уже тёмные (палитра OR Chat) — автоматическое затемнение отключено (API 29+)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                @Suppress("DEPRECATION")
                forceDark = WebSettings.FORCE_DARK_OFF
            }
        }
        webView.setBackgroundColor(0xFF101418.toInt())

        // https-origin для assets — иначе fetch к api.github.com даёт "Failed to fetch" (CORS с file://)
        val assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        webView.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(
                view: WebView?,
                request: WebResourceRequest?
            ): WebResourceResponse? {
                val uri = request?.url ?: return super.shouldInterceptRequest(view, request)
                return assetLoader.shouldInterceptRequest(uri)
            }

            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val url = request?.url?.toString() ?: return false
                return when {
                    url.startsWith("https://appassets.androidplatform.net/") -> false
                    url.startsWith("file:///android_asset/") -> false
                    url.startsWith("http://") || url.startsWith("https://") -> {
                        openExternal(url)
                        true
                    }
                    else -> false
                }
            }

            override fun onPageFinished(view: WebView?, url: String?) {
                super.onPageFinished(view, url)
                supportActionBar?.title = when (pageItemId(url)) {
                    R.id.nav_files -> getString(R.string.files_title)
                    R.id.nav_unzip -> getString(R.string.unzip_title)
                    R.id.nav_tokens -> getString(R.string.tokens_title)
                    R.id.nav_releases -> getString(R.string.releases_title)
                    else -> getString(R.string.repos_title)
                }
                syncNav(url)
                updateHeaderRepo()
            }

            override fun onRenderProcessGone(
                view: WebView?,
                detail: RenderProcessGoneDetail?
            ): Boolean {
                // Процесс рендера умер: WebView использовать нельзя, пересоздаём Activity
                resetBusyState()
                Toast.makeText(this@MainActivity, getString(R.string.webview_crashed), Toast.LENGTH_SHORT).show()
                if (!isFinishing && !isDestroyed) recreate()
                return true
            }

            override fun onReceivedError(
                view: WebView?,
                request: WebResourceRequest?,
                error: WebResourceError?
            ) {
                super.onReceivedError(view, request, error)
                if (request?.isForMainFrame == true) {
                    Toast.makeText(
                        this@MainActivity,
                        getString(R.string.load_error, error?.description?.toString() ?: ""),
                        Toast.LENGTH_SHORT
                    ).show()
                }
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            override fun onProgressChanged(view: WebView?, newProgress: Int) {
                binding.pageProgress.progress = newProgress
                binding.pageProgress.visibility = if (newProgress in 0..99) View.VISIBLE else View.GONE
            }

            override fun onJsAlert(
                view: WebView?,
                url: String?,
                message: String?,
                result: JsResult?
            ): Boolean {
                if (isFinishing || isDestroyed) {
                    result?.cancel()
                    return true
                }
                MaterialAlertDialogBuilder(this@MainActivity)
                    .setMessage(message)
                    .setPositiveButton(R.string.ok) { _, _ -> result?.confirm() }
                    .setOnCancelListener { result?.cancel() }
                    .show()
                return true
            }

            override fun onShowFileChooser(
                webView: WebView?,
                callback: ValueCallback<Array<Uri>>?,
                fileChooserParams: FileChooserParams?
            ): Boolean {
                filePathCallback?.onReceiveValue(null)
                filePathCallback = callback
                val intent = fileChooserParams?.createIntent()
                if (intent == null) {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    return false
                }
                try {
                    fileChooserLauncher.launch(intent)
                } catch (e: Exception) {
                    filePathCallback?.onReceiveValue(null)
                    filePathCallback = null
                    Toast.makeText(this@MainActivity, getString(R.string.file_chooser_error), Toast.LENGTH_SHORT).show()
                    return false
                }
                return true
            }
        }

        webView.addJavascriptInterface(WebAppInterface(), "AndroidInterface")
        if (savedState != null && webView.restoreState(savedState) != null) {
            return
        }
        webView.loadUrl(HOME_URL)
    }

    override fun onNavigationItemSelected(item: MenuItem): Boolean {
        when (item.itemId) {
            R.id.nav_home, R.id.nav_unzip, R.id.nav_files, R.id.nav_releases, R.id.nav_tokens -> navigateTo(item.itemId)
            R.id.nav_refresh -> guardUnsaved {
                confirmIfBusy {
                    resetBusyState()
                    binding.webview.reload()
                }
            }
            R.id.nav_about -> showAboutDialog()
        }
        binding.drawerLayout.closeDrawer(GravityCompat.START)
        return true
    }

    private fun pageItemId(url: String?): Int = when {
        url == null -> R.id.nav_home
        url.contains("/assets/files.html") -> R.id.nav_files
        url.contains("/assets/index.html") -> R.id.nav_unzip
        url.contains("/assets/tokens.html") -> R.id.nav_tokens
        url.contains("/assets/releases.html") -> R.id.nav_releases
        else -> R.id.nav_home
    }

    private fun navigateTo(itemId: Int): Boolean {
        val target = when (itemId) {
            R.id.nav_home -> HOME_URL
            R.id.nav_unzip -> UNZIP_URL
            R.id.nav_files -> FILES_URL
            R.id.nav_tokens -> TOKENS_URL
            R.id.nav_releases -> RELEASES_URL
            else -> return false
        }
        if (pageItemId(binding.webview.url) != itemId) {
            guardUnsaved {
                confirmIfBusy {
                    resetBusyState()
                    binding.webview.loadUrl(target)
                }
            }
        }
        return true
    }

    // Подсвечивает текущий раздел в нижней панели и боковом меню
    private fun syncNav(url: String?) {
        val id = pageItemId(url)
        binding.bottomNav.menu.findItem(id)?.isChecked = true
        binding.navView.setCheckedItem(id)
    }

    // В шапке бокового меню показываем выбранный репозиторий
    private fun updateHeaderRepo() {
        val label = binding.navView.getHeaderView(0)?.findViewById<TextView>(R.id.nav_header_repo) ?: return
        binding.webview.evaluateJavascript(
            "(function(){try{var u=localStorage.getItem('unzipgit_username')||'';" +
                "var r=(localStorage.getItem('unzipgit_repo')||'').split('/')[0];return u&&r?u+'/'+r:''}catch(e){return ''}})()"
        ) { res ->
            val v = res?.removeSurrounding("\"")?.trim() ?: ""
            label.text = if (v.isEmpty() || v == "null") getString(R.string.nav_no_repo) else v
        }
    }

    private fun isFilesPage(): Boolean =
        binding.webview.url?.contains("/assets/files.html") == true

    private fun goBackOrExit(callback: OnBackPressedCallback) {
        if (binding.webview.canGoBack()) {
            binding.webview.goBack()
        } else {
            confirmIfBusy {
                callback.isEnabled = false
                onBackPressedDispatcher.onBackPressed()
            }
        }
    }

    // На экране «Файлы» спрашиваем подтверждение, если в редакторе есть несохранённые изменения
    private fun guardUnsaved(action: () -> Unit) {
        if (!isFilesPage()) {
            action()
            return
        }
        binding.webview.evaluateJavascript(
            "(function(){try{return !!(window.__hasUnsaved&&window.__hasUnsaved())}catch(e){return false}})()"
        ) { result ->
            if (result == "true") {
                MaterialAlertDialogBuilder(this)
                    .setMessage(R.string.unsaved_message)
                    .setPositiveButton(R.string.unsaved_leave) { _, _ -> action() }
                    .setNegativeButton(R.string.busy_cancel, null)
                    .show()
            } else {
                action()
            }
        }
    }

    // Страница перезагружается — JS уже не сообщит об окончании операции, сбрасываем флаги сами
    private fun resetBusyState() {
        cancelAllTransfers()
        operationRunning = false
        window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    }

    private fun confirmIfBusy(action: () -> Unit) {
        if (!operationRunning) {
            action()
            return
        }
        MaterialAlertDialogBuilder(this)
            .setMessage(R.string.busy_message)
            .setPositiveButton(R.string.busy_continue) { _, _ -> action() }
            .setNegativeButton(R.string.busy_cancel, null)
            .show()
    }

    private fun openExternal(url: String) {
        try {
            startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url)))
        } catch (e: Exception) {
            Toast.makeText(this, getString(R.string.no_browser), Toast.LENGTH_SHORT).show()
        }
    }

    // Вызов JS-функции страницы из любого потока (аргументы: строки, числа, булевы, null)
    private fun jsCall(fn: String, vararg args: Any?) {
        val call = fn + "(" + args.joinToString(",") { a ->
            when (a) {
                null -> "null"
                is String -> JSONObject.quote(a)
                else -> a.toString()
            }
        } + ")"
        runOnUiThread {
            if (isFinishing || isDestroyed) return@runOnUiThread
            try {
                binding.webview.evaluateJavascript("(function(){try{" + call + "}catch(e){}})()", null)
            } catch (_: Exception) { }
        }
    }

    private fun cancelAllTransfers() {
        for (k in transfers.keys) transfers[k] = true
    }

    private fun queryMeta(uri: Uri): Pair<String, Long> {
        var name: String? = null
        var size = -1L
        try {
            contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { c ->
                if (c.moveToFirst()) {
                    val ni = c.getColumnIndex(OpenableColumns.DISPLAY_NAME)
                    if (ni >= 0 && !c.isNull(ni)) name = c.getString(ni)
                    val si = c.getColumnIndex(OpenableColumns.SIZE)
                    if (si >= 0 && !c.isNull(si)) size = c.getLong(si)
                }
            }
        } catch (_: Exception) { }
        val finalName = name?.takeIf { it.isNotBlank() }
            ?: uri.lastPathSegment?.substringAfterLast('/')?.takeIf { it.isNotBlank() }
            ?: "file"
        return Pair(finalName, size)
    }

    private fun readBodyText(conn: HttpURLConnection): String {
        return try {
            val st = if (conn.responseCode in 200..299) conn.inputStream else conn.errorStream
            if (st == null) "" else st.bufferedReader(Charsets.UTF_8).use { it.readText() }.take(20000)
        } catch (e: Exception) {
            ""
        }
    }

    // Отправка файла как ресурса релиза GitHub (потоковая, с прогрессом и отменой)
    private fun doUpload(id: String, f: PickedFile, uploadUrl: String, token: String, mime: String) {
        var conn: HttpURLConnection? = null
        var temp: File? = null
        try {
            if (!uploadUrl.startsWith("https://uploads.github.com/")) {
                throw IllegalArgumentException("Недопустимый адрес загрузки")
            }
            var size = f.size
            var tempFile: File? = null
            if (size <= 0) {
                // Размер неизвестен — копируем во временный файл, чтобы узнать длину
                val t = File.createTempFile("upload", ".tmp", cacheDir)
                temp = t
                tempFile = t
                val input = contentResolver.openInputStream(f.uri) ?: throw IOException("Не удалось открыть файл")
                input.use { i -> t.outputStream().use { o -> i.copyTo(o) } }
                size = t.length()
            }
            if (size <= 0) throw IOException("Пустой файл нельзя загрузить в релиз")

            val c = URL(uploadUrl).openConnection() as HttpURLConnection
            conn = c
            c.requestMethod = "POST"
            c.connectTimeout = 30000
            c.readTimeout = 120000
            c.doOutput = true
            c.doInput = true
            c.instanceFollowRedirects = false
            c.setRequestProperty("Authorization", "token $token")
            c.setRequestProperty("Accept", "application/vnd.github+json")
            c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            c.setRequestProperty("Content-Type", mime.ifBlank { "application/octet-stream" })
            c.setFixedLengthStreamingMode(size)

            val source = if (tempFile != null) tempFile.inputStream() else contentResolver.openInputStream(f.uri)
                ?: throw IOException("Не удалось открыть файл")
            var sent = 0L
            var lastEmit = 0L
            c.outputStream.use { os ->
                source.use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (transfers[id] == true) throw InterruptedIOException("cancelled")
                        val n = input.read(buf)
                        if (n < 0) break
                        os.write(buf, 0, n)
                        sent += n
                        val now = System.currentTimeMillis()
                        if (now - lastEmit > 200) {
                            lastEmit = now
                            jsCall("window.__ugProgress", id, sent, size)
                        }
                    }
                }
            }
            jsCall("window.__ugProgress", id, size, size)
            val status = c.responseCode
            val body = readBodyText(c)
            jsCall("window.__ugDone", id, status, body)
        } catch (e: InterruptedIOException) {
            jsCall("window.__ugDone", id, -1, "cancelled")
        } catch (e: Exception) {
            if (transfers[id] == true) {
                jsCall("window.__ugDone", id, -1, "cancelled")
            } else {
                jsCall("window.__ugDone", id, 0, e.javaClass.simpleName + ": " + (e.message ?: ""))
            }
        } finally {
            transfers.remove(id)
            try { conn?.disconnect() } catch (_: Exception) { }
            try { temp?.delete() } catch (_: Exception) { }
        }
    }

    // Скачивание ресурса релиза в выбранное пользователем место
    private fun doDownload(p: PendingDownload, uri: Uri) {
        var conn: HttpURLConnection? = null
        var ok = false
        transfers[p.id] = false
        try {
            var url = p.url
            var withAuth = true
            var hops = 0
            var total = -1L
            var stream: java.io.InputStream? = null
            while (true) {
                val c = URL(url).openConnection() as HttpURLConnection
                conn = c
                c.instanceFollowRedirects = false
                c.connectTimeout = 30000
                c.readTimeout = 120000
                // Токен отправляем только в GitHub API: ссылка на хранилище подписана и с токеном её не примет
                if (withAuth) c.setRequestProperty("Authorization", "token ${p.token}")
                c.setRequestProperty("Accept", "application/octet-stream")
                c.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
                val st = c.responseCode
                if (st == 301 || st == 302 || st == 303 || st == 307 || st == 308) {
                    val loc = c.getHeaderField("Location") ?: throw IOException("Пустое перенаправление")
                    c.disconnect()
                    hops++
                    if (hops > 5) throw IOException("Слишком много перенаправлений")
                    url = URL(URL(url), loc).toString()
                    if (!url.startsWith("https://")) throw IOException("Небезопасное перенаправление")
                    withAuth = false
                    continue
                }
                if (st !in 200..299) {
                    val msg = try { JSONObject(readBodyText(c)).optString("message", "") } catch (e: Exception) { "" }
                    throw IOException("HTTP $st" + if (msg.isNotEmpty()) ": $msg" else "")
                }
                total = c.contentLengthLong
                stream = c.inputStream
                break
            }
            val out = contentResolver.openOutputStream(uri, "wt") ?: throw IOException("Не удалось открыть файл для записи")
            var done = 0L
            var lastEmit = 0L
            out.use { os ->
                (stream ?: throw IOException("Пустой ответ")).use { input ->
                    val buf = ByteArray(64 * 1024)
                    while (true) {
                        if (transfers[p.id] == true) throw InterruptedIOException("cancelled")
                        val n = input.read(buf)
                        if (n < 0) break
                        os.write(buf, 0, n)
                        done += n
                        val now = System.currentTimeMillis()
                        if (now - lastEmit > 200) {
                            lastEmit = now
                            jsCall("window.__ugProgress", p.id, done, total)
                        }
                    }
                }
            }
            ok = true
            jsCall("window.__ugDownloadDone", p.id, true, "")
        } catch (e: InterruptedIOException) {
            jsCall("window.__ugDownloadDone", p.id, false, "cancel")
        } catch (e: Exception) {
            jsCall("window.__ugDownloadDone", p.id, false, e.message ?: e.javaClass.simpleName)
        } finally {
            transfers.remove(p.id)
            try { conn?.disconnect() } catch (_: Exception) { }
            if (!ok) {
                // Не оставляем пустой или недокачанный файл
                try { DocumentsContract.deleteDocument(contentResolver, uri) } catch (_: Exception) { }
            }
        }
    }

    private fun showAboutDialog() {
        val ver = try {
            packageManager.getPackageInfo(packageName, 0).versionName ?: "?"
        } catch (e: Exception) {
            "?"
        }
        MaterialAlertDialogBuilder(this)
            .setTitle(R.string.about_title)
            .setMessage("UnzipGit\nВерсия: $ver\n\n${getString(R.string.about_text)}")
            .setPositiveButton(R.string.ok, null)
            .show()
    }

    inner class WebAppInterface {
        /** Системное окно выбора файлов (любой формат). Результат — window.__ugPicked(json). */
        @JavascriptInterface
        fun pickFiles() {
            runOnUiThread {
                try {
                    pickLauncher.launch(arrayOf("*/*"))
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, getString(R.string.file_chooser_error), Toast.LENGTH_SHORT).show()
                    jsCall("window.__ugPicked", "[]")
                }
            }
        }

        /** Загрузка выбранного файла (id из pickFiles) как ресурса релиза. Итог — window.__ugDone(id, status, body). */
        @JavascriptInterface
        fun uploadAsset(id: String, uploadUrl: String, token: String, name: String, mime: String) {
            val f = pickedFiles[id]
            if (f == null) {
                jsCall("window.__ugDone", id, 0, "Файл не найден. Выберите его заново.")
                return
            }
            transfers[id] = false
            try {
                httpExecutor.execute { doUpload(id, f, uploadUrl, token, mime) }
            } catch (e: Exception) {
                transfers.remove(id)
                jsCall("window.__ugDone", id, 0, e.message ?: "Ошибка запуска загрузки")
            }
        }

        /** Скачивание ресурса релиза: сначала системное окно «Сохранить как…». Итог — window.__ugDownloadDone. */
        @JavascriptInterface
        fun downloadAsset(id: String, apiUrl: String, token: String, name: String) {
            if (!apiUrl.startsWith("https://api.github.com/")) {
                jsCall("window.__ugDownloadDone", id, false, "Недопустимый адрес")
                return
            }
            val safeName = name.replace('/', '_').ifBlank { "file" }
            runOnUiThread {
                val prev = pendingDownload
                if (prev != null) jsCall("window.__ugDownloadDone", prev.id, false, "cancel")
                pendingDownload = PendingDownload(id, apiUrl, token)
                try {
                    downloadLauncher.launch(safeName)
                } catch (e: Exception) {
                    pendingDownload = null
                    jsCall("window.__ugDownloadDone", id, false, getString(R.string.file_save_unavailable))
                }
            }
        }

        @JavascriptInterface
        fun cancelTransfer(id: String) {
            if (transfers.containsKey(id)) transfers[id] = true
        }

        @JavascriptInterface
        fun showToast(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_SHORT).show()
            }
        }

        @JavascriptInterface
        fun showError(message: String) {
            runOnUiThread {
                Toast.makeText(this@MainActivity, message, Toast.LENGTH_LONG).show()
            }
        }

        @JavascriptInterface
        fun keepScreenOn(enable: Boolean) {
            operationRunning = enable
            runOnUiThread {
                if (enable) {
                    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                } else {
                    window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
                }
            }
        }

        @JavascriptInterface
        fun isOnline(): Boolean {
            return try {
                val cm = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
                val caps = cm.getNetworkCapabilities(cm.activeNetwork)
                caps?.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) == true
            } catch (e: Exception) {
                true
            }
        }

        @JavascriptInterface
        fun getAppVersion(): String {
            return try {
                packageManager.getPackageInfo(packageName, 0).versionName ?: "3.23"
            } catch (e: Exception) {
                "3.23"
            }
        }

        @JavascriptInterface
        fun openUrl(url: String) {
            runOnUiThread {
                openExternal(url)
            }
        }

        /**
         * Сохранение файла на устройство: показывает системное окно «Сохранить как…».
         * base64 — содержимое файла в кодировке Base64.
         */
        @JavascriptInterface
        fun saveFile(fileName: String, mime: String, base64: String) {
            val bytes = try {
                android.util.Base64.decode(base64, android.util.Base64.DEFAULT)
            } catch (e: Exception) {
                null
            }
            if (bytes == null) {
                runOnUiThread {
                    Toast.makeText(this@MainActivity, getString(R.string.file_save_error), Toast.LENGTH_SHORT).show()
                }
                return
            }
            pendingSave = bytes
            val safeName = fileName.replace('/', '_').ifBlank { "file" }
            runOnUiThread {
                try {
                    saveLauncher.launch(safeName)
                } catch (e: Exception) {
                    pendingSave = null
                    Toast.makeText(this@MainActivity, getString(R.string.file_save_unavailable), Toast.LENGTH_SHORT).show()
                }
            }
        }

        @JavascriptInterface
        fun shareText(text: String, title: String) {
            runOnUiThread {
                try {
                    val send = Intent(Intent.ACTION_SEND).apply {
                        type = "text/plain"
                        putExtra(Intent.EXTRA_TEXT, text)
                        putExtra(Intent.EXTRA_SUBJECT, title)
                    }
                    startActivity(Intent.createChooser(send, title))
                } catch (e: Exception) {
                    Toast.makeText(this@MainActivity, getString(R.string.no_browser), Toast.LENGTH_SHORT).show()
                }
            }
        }

        /**
         * Нативный HTTP для обхода CORS в WebView.
         * requestJson: {"url","method","headers":{},"body":"optional string"}
         * Возвращает JSON: {"ok","status","statusText","headers":{},"body":"...","isBase64":bool}
         */
        @JavascriptInterface
        fun httpRequest(requestJson: String): String {
            return try {
                val future = httpExecutor.submit<String> {
                    httpRequestSync(requestJson)
                }
                try {
                    future.get(125, TimeUnit.SECONDS)
                } catch (e: Exception) {
                    future.cancel(true)
                    throw e
                }
            } catch (e: Exception) {
                JSONObject().apply {
                    put("ok", false)
                    put("status", 0)
                    put("statusText", e.message ?: "network error")
                    put("headers", JSONObject())
                    put("body", "")
                    put("isBase64", false)
                    put("error", e.javaClass.simpleName + ": " + (e.message ?: ""))
                }.toString()
            }
        }

        private fun httpRequestSync(requestJson: String): String {
            return try {
                val req = JSONObject(requestJson)
                val urlStr = req.getString("url")
                val method = req.optString("method", "GET").uppercase()
                val headersJson = req.optJSONObject("headers")
                val bodyStr = if (req.has("body") && !req.isNull("body")) req.getString("body") else null
                val wantBinary = req.optBoolean("binary", false)

                val conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                    requestMethod = method
                    connectTimeout = 30000
                    readTimeout = 120000
                    doInput = true
                    instanceFollowRedirects = true
                    if (headersJson != null) {
                        val keys = headersJson.keys()
                        while (keys.hasNext()) {
                            val k = keys.next()
                            setRequestProperty(k, headersJson.getString(k))
                        }
                    }
                    if (bodyStr != null && method != "GET" && method != "HEAD") {
                        doOutput = true
                        outputStream.use { os ->
                            os.write(bodyStr.toByteArray(Charsets.UTF_8))
                        }
                    }
                }

                // Ошибка соединения (таймаут, нет сети) должна попасть во внешний catch
                // и вернуться в JS как status=0 + error, а не как «ответ» со статусом -1
                val status = conn.responseCode
                val statusText = try { conn.responseMessage ?: "" } catch (e: Exception) { "" }
                val stream = if (status in 200..299) conn.inputStream else conn.errorStream
                val bytes = if (stream != null) {
                    BufferedInputStream(stream).use { input ->
                        val buf = ByteArrayOutputStream()
                        val tmp = ByteArray(8192)
                        while (true) {
                            val n = input.read(tmp)
                            if (n <= 0) break
                            buf.write(tmp, 0, n)
                        }
                        buf.toByteArray()
                    }
                } else ByteArray(0)

                val respHeaders = JSONObject()
                conn.headerFields?.forEach { (k, v) ->
                    if (k != null && v != null && v.isNotEmpty()) {
                        respHeaders.put(k, v.joinToString(", "))
                    }
                }

                val bodyOut: String
                val isBase64: Boolean
                // binary=true от JS — всегда base64 (ZIP/raw), иначе эвристика по Content-Type
                if (wantBinary || (conn.contentType?.contains("octet-stream") == true) ||
                    (conn.contentType?.contains("zip") == true) ||
                    (conn.contentType?.startsWith("image/") == true) ||
                    (conn.contentType?.startsWith("application/") == true && conn.contentType?.contains("json") != true)
                ) {
                    bodyOut = android.util.Base64.encodeToString(bytes, android.util.Base64.NO_WRAP)
                    isBase64 = true
                } else {
                    bodyOut = String(bytes, Charsets.UTF_8)
                    isBase64 = false
                }

                try { conn.disconnect() } catch (_: Exception) { }

                JSONObject().apply {
                    put("ok", status in 200..299)
                    put("status", status)
                    put("statusText", statusText)
                    put("headers", respHeaders)
                    put("body", bodyOut)
                    put("isBase64", isBase64)
                }.toString()
            } catch (e: Exception) {
                JSONObject().apply {
                    put("ok", false)
                    put("status", 0)
                    put("statusText", e.message ?: "network error")
                    put("headers", JSONObject())
                    put("body", "")
                    put("isBase64", false)
                    put("error", e.javaClass.simpleName + ": " + (e.message ?: ""))
                }.toString()
            }
        }
    }
}
