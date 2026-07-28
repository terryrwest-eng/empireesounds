plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.empiresounds.station"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.empiresounds.station"
        minSdk = 24
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
        debug {
            applicationIdSuffix = ".debug"
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    packaging {
        resources.excludes += "/META-INF/{AL2.0,LGPL2.1}"
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    // WebViewAssetLoader: serves the bundled app from an https origin, so
    // localStorage, the service worker and geolocation all behave normally.
    implementation("androidx.webkit:webkit:1.11.0")
    // USB serial chip drivers (CDC-ACM for the F9P's native USB, plus CP210x,
    // CH34x, FTDI, PL2303). The one thing here that cannot be verified without
    // every chip on the bench, so it uses the library the ecosystem trusts.
    implementation("com.github.mik3y:usb-serial-for-android:3.8.1")
}

// The UI is the same code the web app uses — one stationing engine, one set of
// tests. Gradle copies it into assets at build time rather than duplicating it.
val webAppDir = rootProject.file("../station")

val copyWebApp by tasks.registering(Copy::class) {
    description = "Bundle the shared Station web app into the APK"
    from(webAppDir) {
        exclude("test/**", "README.md", "sw.js") // the APK is already offline
    }
    into(layout.buildDirectory.dir("generated/webassets/station"))
}

android.sourceSets["main"].assets.srcDir(layout.buildDirectory.dir("generated/webassets"))

tasks.named("preBuild") { dependsOn(copyWebApp) }
