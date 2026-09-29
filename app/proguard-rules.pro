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
