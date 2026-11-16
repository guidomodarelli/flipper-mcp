plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.example.fluxsample"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.example.fluxsample"
        minSdk = 23
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    packaging { jniLibs { useLegacyPackaging = true } }
}

dependencies {
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("com.google.code.gson:gson:2.11.0")

    // Flipper and the Flux plugin exist only in debug builds.
    debugImplementation("com.facebook.flipper:flipper:0.273.0")
    debugImplementation("com.facebook.flipper:flipper-network-plugin:0.273.0")
    debugImplementation("com.facebook.soloader:soloader:0.10.4")
    debugImplementation(project(":flux-flipper"))
}
