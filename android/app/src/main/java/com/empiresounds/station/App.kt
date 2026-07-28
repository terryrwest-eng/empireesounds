package com.empiresounds.station

import android.app.Application
import android.content.Context

/** Holds an application context so the transports can reopen a device without
 *  being handed an Activity that may already be gone. */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        instance = this
    }

    companion object {
        private lateinit var instance: App
        val context: Context get() = instance.applicationContext
    }
}
