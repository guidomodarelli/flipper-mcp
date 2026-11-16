plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "com.guidomodarelli.fluxflipper"
    compileSdk = 34
    defaultConfig {
        minSdk = 23
        consumerProguardFiles("consumer-rules.pro")
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    // The app brings Flipper itself (debugImplementation); the plugin only compiles against it.
    compileOnly("com.facebook.flipper:flipper:0.273.0")
    api("com.google.code.gson:gson:2.11.0")
    testImplementation("junit:junit:4.13.2")
}
