# ProGuard rules for UnzipGit WebView wrapper

-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

-keepclassmembers class com.unzipgit.app.MainActivity$WebAppInterface {
    <methods>;
}

-keep class com.unzipgit.app.MainActivity { *; }
-keep class com.unzipgit.app.MainActivity$WebAppInterface { *; }

-keep class android.webkit.** { *; }
-keepclassmembers class android.webkit.** { *; }

# ViewBinding
-keep class com.unzipgit.app.databinding.** { *; }

# JS bridge callbacks are invoked by name from Kotlin — do not strip related Activity bits
-keepclassmembers class com.unzipgit.app.MainActivity {
    *** jsCall(...);
    *** doDownload(...);
    *** doUpload(...);
}
